// SPDX-License-Identifier: AGPL-3.0-only
import { app } from "./app";

console.log(await (await app.request("/openapi.json")).text());
