// Private usage stats for the site owner: recent research events and
// today's totals, read from the same Upstash store the research endpoint
// logs to. Disabled (404) unless STATS_TOKEN is set in the environment;
// callers must present the same token in the x-stats-token header. Event
// IPs are stored only as short hashes — enough to tell visitors apart,
// not to identify anyone.

export default async function handler(req, res) {
  const token = process.env.STATS_TOKEN;
  if (!token) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if ((req.headers["x-stats-token"] || "") !== token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const storeToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !storeToken) {
    res.status(200).json({ totalToday: 0, distinctVisitorsToday: 0, events: [], note: "No store configured" });
    return;
  }

  try {
    const r = await fetch(`${url}/lrange/usage-events/0/199`, {
      headers: { Authorization: `Bearer ${storeToken}` },
    });
    const data = await r.json();
    const events = (data?.result || [])
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const today = new Date().toISOString().slice(0, 10);
    const todays = events.filter((e) => (e.t || "").startsWith(today));
    res.status(200).json({
      totalToday: todays.length,
      distinctVisitorsToday: new Set(todays.map((e) => e.ip)).size,
      freshToday: todays.filter((e) => !e.cached).length,
      cachedToday: todays.filter((e) => e.cached).length,
      events: events.slice(0, 50),
    });
  } catch (err) {
    res.status(502).json({ error: err?.message || "Stats read failed" });
  }
}
