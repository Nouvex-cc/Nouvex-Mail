// SPDX-License-Identifier: Apache-2.0
// Headless client core. Must never import from apps/ or engine/ (AGPL).

export function createClient(baseUrl: string, fetcher: typeof fetch = fetch) {
	return {
		health: async () => (await fetcher(`${baseUrl}/health`)).json() as Promise<{ ok: boolean }>,
	};
}
