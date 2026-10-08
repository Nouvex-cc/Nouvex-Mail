// SPDX-License-Identifier: AGPL-3.0-only
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

export const db = drizzle(process.env.DATABASE_URL ?? "", { schema });
