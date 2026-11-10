// SPDX-License-Identifier: Apache-2.0
// The dark engine as the Apple apps load it (MailDark.js); the app puts its colors in front.
import { darken } from "./mail-dark";

declare const NOUVEX_DARK: [string, string];
darken(document, NOUVEX_DARK[0], NOUVEX_DARK[1]);
