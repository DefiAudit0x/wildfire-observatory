export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target) {
      return json({ error: "Missing url" }, 400);
    }

    try {
      const targetUrl = new URL(target);
      if (targetUrl.protocol !== "https:") {
        return json({ error: "Only HTTPS upstreams are allowed" }, 400);
      }
      const resp = await fetch(targetUrl, {
        headers: { "User-Agent": "VIGIL-Observatory-Proxy/1.0" },
      });
      return new Response(resp.body, {
        status: resp.status,
        headers: {
          "Content-Type": resp.headers.get("Content-Type") || "text/plain",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (err) {
      console.error("FIRMS upstream request failed", err);
      return new Response("Upstream error", { status: 502 });
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
