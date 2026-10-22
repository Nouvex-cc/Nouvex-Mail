// SPDX-License-Identifier: AGPL-3.0-only
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins";
import { db } from "./db";

const web = process.env.WEB_ORIGIN ?? "http://localhost:5173";

export const auth = betterAuth({
	appName: "Nouvex",
	database: drizzleAdapter(db, { provider: "pg" }),
	// Nobody signs up on their own; accounts come from src/user.ts.
	emailAndPassword: { enabled: true, disableSignUp: true },
	user: { deleteUser: { enabled: true } },
	trustedOrigins: [web],
	plugins: [passkey({ rpName: "Nouvex", rpID: new URL(web).hostname, origin: web }), twoFactor()],
});
