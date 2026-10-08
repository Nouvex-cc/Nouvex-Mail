// SPDX-License-Identifier: AGPL-3.0-only
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import * as Sentry from "@sentry/bun";

if (process.env.SENTRY_DSN) Sentry.init({ dsn: process.env.SENTRY_DSN });

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
	new NodeSDK({ serviceName: "nouvex-api", traceExporter: new OTLPTraceExporter() }).start();
}
