// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "bun:test";
import { fetchImage, isPublic } from "./image";

test("only public addresses", () => {
	for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.1", "::1", "fd00::1", "::ffff:127.0.0.1"])
		expect(isPublic(ip)).toBe(false);
	for (const ip of ["93.184.216.34", "2606:4700::1111"]) expect(isPublic(ip)).toBe(true);
});

test("never fetches internal hosts or other schemes", async () => {
	for (const url of ["http://localhost:3000/health", "http://[::1]/", "http://169.254.169.254/", "file:///etc/passwd"])
		expect(await fetchImage(url)).toBeUndefined();
});
