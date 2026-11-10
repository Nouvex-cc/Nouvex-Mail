// SPDX-License-Identifier: AGPL-3.0-only

// Package ses sends hosted accounts' mail out through Amazon SES and sets their domains up there: each domain signs
// with its own DKIM key (BYODKIM, selector nx1), so the same key can sign on our own servers later, and bounces come
// back through bounce.<domain>. SES's errors become SMTP replies, so a send is retried or given up like any other.
package ses

import (
	"context"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	"github.com/aws/aws-sdk-go-v2/service/sesv2/types"
	"github.com/aws/smithy-go"
	"github.com/emersion/go-smtp"
)

// Client is SES in one region, with the configuration set whose events (bounces, complaints) go to our webhook.
type Client struct {
	c         *sesv2.Client
	configSet string
}

// New connects to SES in region with the AWS credentials from the environment; endpoint is for tests.
func New(ctx context.Context, region, configSet, endpoint string) (*Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, err
	}
	c := sesv2.NewFromConfig(cfg, func(o *sesv2.Options) {
		if endpoint != "" {
			o.BaseEndpoint = aws.String(endpoint)
		}
	})
	return &Client{c: c, configSet: configSet}, nil
}

// most is how many recipients SES takes per message.
const most = 50

// Send hands a message to SES for these recipients, in batches SES takes. tags come back with its reports.
func (c *Client) Send(ctx context.Context, from string, to []string, raw []byte, tags map[string]string) error {
	var mt []types.MessageTag
	for k, v := range tags {
		mt = append(mt, types.MessageTag{Name: aws.String(k), Value: aws.String(v)})
	}
	for batch := range slices.Chunk(to, most) {
		in := &sesv2.SendEmailInput{
			FromEmailAddress: aws.String(from),
			Destination:      &types.Destination{ToAddresses: batch},
			Content:          &types.EmailContent{Raw: &types.RawMessage{Data: raw}},
			EmailTags:        mt,
		}
		if c.configSet != "" {
			in.ConfigurationSetName = aws.String(c.configSet)
		}
		if _, err := c.c.SendEmail(ctx, in); err != nil {
			return reply(err)
		}
	}
	return nil
}

// reply turns what SES said into an SMTP reply: throttling and its own troubles are worth another try, a refusal
// isn't.
func reply(err error) error {
	var api smithy.APIError
	if !errors.As(err, &api) {
		// Couldn't reach SES at all.
		return &smtp.SMTPError{Code: 451, EnhancedCode: smtp.EnhancedCode{4, 4, 0}, Message: "Amazon SES couldn't be reached"}
	}
	switch api.ErrorCode() {
	case "TooManyRequestsException", "LimitExceededException", "InternalServiceErrorException", "ServiceUnavailable", "Throttling":
		return &smtp.SMTPError{Code: 451, EnhancedCode: smtp.EnhancedCode{4, 3, 0}, Message: "Amazon SES: " + api.ErrorMessage()}
	}
	return &smtp.SMTPError{Code: 554, EnhancedCode: smtp.EnhancedCode{5, 7, 1}, Message: "Amazon SES: " + api.ErrorMessage()}
}

// SetUp makes a domain an SES identity once, signing with its own DKIM key (PKCS#8, base64, as the API made it) and
// bouncing through bounce.<domain>, and says how far SES is: "ready", or what it still waits for.
func (c *Client) SetUp(ctx context.Context, domain, privateKey string) (string, error) {
	_, err := c.c.GetEmailIdentity(ctx, &sesv2.GetEmailIdentityInput{EmailIdentity: aws.String(domain)})
	var missing *types.NotFoundException
	if errors.As(err, &missing) {
		key, err := pkcs1(privateKey)
		if err != nil {
			return "", err
		}
		in := &sesv2.CreateEmailIdentityInput{
			EmailIdentity: aws.String(domain),
			DkimSigningAttributes: &types.DkimSigningAttributes{
				DomainSigningSelector: aws.String("nx1"), DomainSigningPrivateKey: aws.String(key),
			},
		}
		if c.configSet != "" {
			in.ConfigurationSetName = aws.String(c.configSet)
		}
		if _, err := c.c.CreateEmailIdentity(ctx, in); err != nil {
			return "", err
		}
		if _, err := c.c.PutEmailIdentityMailFromAttributes(ctx, &sesv2.PutEmailIdentityMailFromAttributesInput{
			EmailIdentity: aws.String(domain), MailFromDomain: aws.String("bounce." + domain),
			BehaviorOnMxFailure: types.BehaviorOnMxFailureUseDefaultValue,
		}); err != nil {
			return "", err
		}
	} else if err != nil {
		return "", err
	}
	got, err := c.c.GetEmailIdentity(ctx, &sesv2.GetEmailIdentityInput{EmailIdentity: aws.String(domain)})
	if err != nil {
		return "", err
	}
	var waiting []string
	if got.DkimAttributes == nil || got.DkimAttributes.Status != types.DkimStatusSuccess {
		waiting = append(waiting, "DKIM")
	}
	if got.MailFromAttributes == nil || got.MailFromAttributes.MailFromDomainStatus != types.MailFromDomainStatusSuccess {
		waiting = append(waiting, "the bounce domain")
	}
	if !got.VerifiedForSendingStatus || len(waiting) > 0 {
		if len(waiting) == 0 {
			waiting = append(waiting, "verification")
		}
		return "waiting for " + strings.Join(waiting, " and "), nil
	}
	return "ready", nil
}

// pkcs1 is the private key the way SES takes it: PKCS#1, base64 without PEM lines.
func pkcs1(pkcs8 string) (string, error) {
	der, err := base64.StdEncoding.DecodeString(pkcs8)
	if err != nil {
		return "", err
	}
	k, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return "", err
	}
	rsaKey, ok := k.(*rsa.PrivateKey)
	if !ok {
		return "", fmt.Errorf("DKIM key is %T, not RSA", k)
	}
	return base64.StdEncoding.EncodeToString(x509.MarshalPKCS1PrivateKey(rsaKey)), nil
}
