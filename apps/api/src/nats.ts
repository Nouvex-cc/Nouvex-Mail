// SPDX-License-Identifier: AGPL-3.0-only
import { jetstream } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";

// The engine owns the COMMANDS stream, the API only publishes into it. Reconnects forever: giving up after a few
// tries left the API dead after the laptop slept.
const setup = async () => {
	const nc = await connect({ servers: process.env.NATS_URL ?? "nats://localhost:4222", maxReconnectAttempts: -1 });
	return { nc, js: jetstream(nc) };
};

let conn: ReturnType<typeof setup> | undefined;
export const nats = () => (conn ??= setup());
