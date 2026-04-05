/**
 * PMOE Command Center — Smartsheet Proxy API
 * Deploy on Render (free tier) at https://render.com
 *
 * Environment variable required (set in Render dashboard):
 *   SMARTSHEET_TOKEN  — your Smartsheet API access token
 *
 * Endpoints:
 *   GET /api/data      — fetch all live dashboard data (report + risk logs)
 *   GET /api/health    — health check
 */

const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Allow requests from any origin (the dashboard HTML can be hosted anywhere) ──
app.use(cors());
app.use(express.json());

// ── Smartsheet config ─────────────────────────────────────────────────────────
const SS_TOKEN        = process.env.SMARTSHEET_TOKEN;
const SS_BASE         = 'https://api.smartsheet.com/2.0';

const REPORT_ID       = '7165261019828100';   // PMOE Load - Update report
const RISK_SHEET_PG   = '3689972654624644';   // CCH-Press Ganey Risks Log
const RISK_SHEET_LAB  = '7875273287487364';   // Lab Automation Risks Log
const COMPLIANCE_SHEET = '2177565233991556';  // PM Process Compliance Audit

function ssHeaders() {
  return {
    'Authorization': `Bearer ${SS_TOKEN}`,
    'Content-Type':  'application/json',
  };
}

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    token_set: !!SS_TOKEN,
  });
});

// ── Main data endpoint ────────────────────────────────────────────────────────
app.get('/api/data', async (req, res) => {
  if (!SS_TOKEN) {
    return res.status(500).json({ error: 'SMARTSHEET_TOKEN environment variable not set on server.' });
  }

  try {
    // Fetch all sources in parallel
    const [reportRes, pgRiskRes, labRiskRes, complianceRes] = await Promise.all([
      fetch(`${SS_BASE}/reports/${REPORT_ID}?pageSize=100`, { headers: ssHeaders() }),
      fetch(`${SS_BASE}/sheets/${RISK_SHEET_PG}?pageSize=100`,  { headers: ssHeaders() }),
      fetch(`${SS_BASE}/sheets/${RISK_SHEET_LAB}?pageSize=100`, { headers: ssHeaders() }),
      fetch(`${SS_BASE}/sheets/${COMPLIANCE_SHEET}?pageSize=200`, { headers: ssHeaders() }),
    ]);

    // Check for auth errors
    if (reportRes.status === 401) {
      return res.status(401).json({ error: 'Smartsheet token invalid or expired. Update SMARTSHEET_TOKEN in Render.' });
    }
    if (!reportRes.ok) {
      return res.status(502).json({ error: `Smartsheet report fetch failed: ${reportRes.status}` });
    }

    const [reportData, pgRiskData, labRiskData, complianceData] = await Promise.all([
      reportRes.json(),
      pgRiskRes.json(),
      labRiskRes.json(),
      complianceRes.json(),
    ]);

    // ── Parse PMOE Load-Update report into project rows ────────────────────
    const cols       = reportData.columns || [];
    const projectCol  = cols.find(c => c.title === 'Projects')?.virtualId;
    const deliverCol  = cols.find(c => c.title === 'Deliverable')?.virtualId;
    const statusCol   = cols.find(c => c.title === 'Status')?.virtualId;
    const assignedCol = cols.find(c => c.title === 'Assigned To')?.virtualId;
    const riskCol     = cols.find(c => c.title === 'Risk or Issue')?.virtualId;
    const impactCol   = cols.find(c => c.title === 'Impact/Notes')?.virtualId;

    const projectMap = {};
    (reportData.rows || []).forEach(row => {
      const cell    = (vid) => (row.cells || []).find(c => c.virtualColumnId == vid);
      const project = cell(projectCol)?.displayValue || '';
      const deliv   = cell(deliverCol)?.displayValue || '';
      const status  = cell(statusCol)?.displayValue || '';
      const assigned= cell(assignedCol)?.displayValue || '';
      const risk    = cell(riskCol)?.displayValue || '';
      const impact  = cell(impactCol)?.displayValue || '';
      const lastMod = (row.modifiedAt || '').split('T')[0];

      if (!project) return;
      if (!projectMap[project]) {
        projectMap[project] = { project, pm: assigned, lastUpdated: lastMod, deliverables: [] };
      }
      if (deliv || status) {
        projectMap[project].deliverables.push({
          name: deliv, status, risk: risk || '', impact: impact || ''
        });
      }
      if (assigned && !projectMap[project].pm)      projectMap[project].pm = assigned;
      if (lastMod > (projectMap[project].lastUpdated || '')) projectMap[project].lastUpdated = lastMod;
    });

    const pmoeLoadData = Object.values(projectMap);

    // ── Parse risk log sheets ──────────────────────────────────────────────
    function parseRiskSheet(sheetData, projectName) {
      const cols    = sheetData.columns || [];
      const highRiskCol = cols.find(c => c.title === 'High Risk')?.id;
      const catCol      = cols.find(c => c.title === 'Category')?.id;
      const descCol     = cols.find(c => c.title === 'Description')?.id;
      const chanceCol   = cols.find(c => c.title === 'Chance of Occuring')?.id;
      const impactCol2  = cols.find(c => c.title === 'Impact')?.id;
      const planCol     = cols.find(c => c.title === 'Action Plan')?.id;

      return (sheetData.rows || [])
        .map(row => {
          const cell = (id) => (row.cells || []).find(c => c.columnId == id);
          const desc = cell(descCol)?.displayValue;
          if (!desc) return null;
          return {
            project:    projectName,
            highRisk:   cell(highRiskCol)?.value === true,
            category:   cell(catCol)?.displayValue || '',
            description: desc,
            chance:     cell(chanceCol)?.displayValue || '',
            impact:     cell(impactCol2)?.displayValue || '',
            actionPlan: cell(planCol)?.displayValue || '',
          };
        })
        .filter(Boolean);
    }

    const risksData = [
      ...parseRiskSheet(pgRiskData,  'CCH-Press Ganey Consumerism'),
      ...parseRiskSheet(labRiskData, 'Lab Automation Upgrade'),
    ];

    // ── Parse PM Process Compliance Audit ─────────────────────────────────
    const compCols    = complianceData.columns || [];
    const projCol     = compCols.find(c => c.title === 'Project')?.id;
    const pmCol       = compCols.find(c => c.title === 'Project Manager')?.id;
    const charterCol  = compCols.find(c => c.title === 'Project Charter - Final Version')?.id;
    const planCol2    = compCols.find(c => c.title === 'Project Plan')?.id;
    const risksLogCol = compCols.find(c => c.title === 'Risks Log')?.id;
    const closeoutCol = compCols.find(c => c.title === 'Closeout Report')?.id;
    const statusCol2  = compCols.find(c => c.title === 'Status')?.id;

    const complianceParsed = (complianceData.rows || []).map(row => {
      const cell = (id) => (row.cells || []).find(c => c.columnId == id);
      const toVal = (cell) => {
        const v = cell?.value;
        if (v === true)  return true;
        if (v === false) return false;
        const d = cell?.displayValue;
        if (d === 'NA' || d == null) return false;
        return v ?? false;
      };
      return {
        project:  cell(projCol)?.displayValue || '',
        pm:       cell(pmCol)?.displayValue   || '',
        charter:  toVal(cell(charterCol)),
        plan:     toVal(cell(planCol2)),
        risks:    toVal(cell(risksLogCol)),
        closeout: toVal(cell(closeoutCol)),
        status:   cell(statusCol2)?.displayValue || '',
      };
    }).filter(r => r.project);

    // ── Return all data ────────────────────────────────────────────────────
    res.json({
      fetchedAt:      new Date().toISOString(),
      pmoeLoadData,
      risksData,
      complianceData: complianceParsed,
      meta: {
        reportRows:     pmoeLoadData.length,
        riskRows:       risksData.length,
        complianceRows: complianceParsed.length,
      }
    });

  } catch (err) {
    console.error('Error fetching Smartsheet data:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`PMOE API server running on port ${PORT}`);
  console.log(`Token configured: ${!!SS_TOKEN}`);
});
