// Vercel Serverless Function: /api/owner-check
// Diagnostic for the owner bypass. Visit
//   https://factjury.com/api/owner-check?t=<your bypass value>
// in a browser. It reports only two booleans — whether the server has
// OWNER_BYPASS_TOKEN configured at all, and whether the supplied value
// matches it exactly. The value itself is never echoed back.

export default function handler(req, res) {
  const expected = process.env.OWNER_BYPASS_TOKEN;
  const configured = typeof expected === "string" && expected.length > 0;
  let supplied = null;
  try {
    supplied = new URL(req.url, "https://factjury.com").searchParams.get("t");
  } catch {
    supplied = null;
  }
  res.status(200).json({
    configured,
    match: configured && typeof supplied === "string" && supplied.length > 0 && supplied === expected,
  });
}
