
// host → "L402 <macaroon>:<preimage>". A bearer credential: never log it.
const tokenCache = new Map();

async function fetchL402Cached(agent, url, options = {}) {
  const { method = "GET", headers = {}, body } = options;
  const host = new URL(url).host;
  const cached = tokenCache.get(host);

  if (cached) {
    const response = await fetch(url, {
      method,
      // Authorization last, so a caller header cannot clobber the credential.
      headers: { "Content-Type": "application/json", ...headers, Authorization: cached },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status !== 402 && response.status !== 401) {
      const ct = response.headers.get("content-type") || "";
      const data = ct.includes("json") ? await response.json() : await response.text();
      return { paid: false, cached: true, data };
    }
    tokenCache.delete(host); // expired or rejected: pay again
  }

  const result = await agent.fetchL402(url, options);
  if (result.paid) tokenCache.set(host, `L402 ${result.macaroon}:${result.preimage}`);
  return result;
}
export { fetchL402Cached, tokenCache };
