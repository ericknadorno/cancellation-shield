const { list } = require('@vercel/blob');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const blobs = await list({ prefix: 'shield-data' });
    if (blobs.blobs.length === 0) {
      return res.status(200).json({ status: 'no_data', message: 'No data yet' });
    }
    const latest = blobs.blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
    const response = await fetch(latest.url);
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Data API error:', err);
    return res.status(500).json({ error: err.message });
  }
};
