#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// nouvex-rich build mail.html --from "Nouvex <hello@nouvex.cc>" [--to a@b.c] [--fallback classic.html] [--text mail.txt] [-o mail.eml]
// nouvex-rich check mail.html
import { parseArgs } from "node:util";
import { build, check } from "./build";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		from: { type: "string" },
		to: { type: "string" },
		subject: { type: "string" },
		fallback: { type: "string" },
		text: { type: "string" },
		out: { type: "string", short: "o" },
	},
});
const [command, file] = positionals;
const read = (path?: string) => (path ? Bun.file(path).text() : undefined);

try {
	if (!file || (command !== "build" && command !== "check"))
		throw new Error("Usage: nouvex-rich build|check <mail.html> [options]");
	const source = await Bun.file(file).text();
	if (command === "check") {
		const problems = check(source);
		console.log(problems.length ? problems.join("\n") : "Fine.");
		process.exit(problems.length ? 1 : 0);
	}
	if (!values.from) throw new Error("--from is needed, e.g. --from 'Nouvex <hello@nouvex.cc>'");
	const eml = await build(source, {
		from: values.from,
		to: values.to,
		subject: values.subject,
		fallback: await read(values.fallback),
		text: await read(values.text),
	});
	if (values.out) await Bun.write(values.out, eml);
	else process.stdout.write(eml);
} catch (e) {
	console.error((e as Error).message);
	process.exit(1);
}
