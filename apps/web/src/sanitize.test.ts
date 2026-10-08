// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, test } from "vitest";
import { sanitize } from "./sanitize";

test("strips scripts", () => {
	expect(sanitize("<p>hi</p><script>alert(1)</script>")).not.toContain("<script");
});
