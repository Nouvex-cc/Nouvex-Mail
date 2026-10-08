// SPDX-License-Identifier: AGPL-3.0-only
import DOMPurify from "dompurify";

// Result is meant for a sandboxed iframe (srcdoc), never for innerHTML in the app itself.
export const sanitize = (html: string) => DOMPurify.sanitize(html, { WHOLE_DOCUMENT: true });
