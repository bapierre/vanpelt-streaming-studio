export type FakeRequest = { url: string; form: URLSearchParams; init: RequestInit };

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function fakeFetch(handler: (req: FakeRequest) => Response | Promise<Response>) {
  const calls: FakeRequest[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const req = {
      url: String(input),
      form: new URLSearchParams(typeof init.body === 'string' ? init.body : ''),
      init,
    };
    calls.push(req);
    return handler(req);
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}
