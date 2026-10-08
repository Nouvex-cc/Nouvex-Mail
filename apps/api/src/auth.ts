// SPDX-License-Identifier: AGPL-3.0-only
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins";
import { db } from "./db";

export const auth = betterAuth({
	database: drizzleAdapter(db, { provider: "pg" }),
	emailAndPassword: { enabled: true },
	trustedOrigins: [process.env.WEB_ORIGIN ?? "http://localhost:5173"],
	plugins: [passkey(), twoFactor()],
});
