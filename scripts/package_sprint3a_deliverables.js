/**
 * Sprint 3A Automated Clean Packaging & Verification Script
 * 
 * Strict delivery package requirements (Section 19):
 * Excludes:
 * - All .git directories at root, frontend, and backend
 * - node_modules
 * - .next, build outputs, and caches
 * - .env files and actual API keys
 * - Passwords, session tokens, and other secrets
 * - Database dumps containing private production data
 * - Private uploaded user images
 * 
 * Includes:
 * - Source code (backend and frontend)
 * - Package manifests and lockfiles
 * - Database migrations (001 through 005)
 * - Automated tests and evaluation suites
 * - Synthetic demo seed and reset scripts
 * - Required Sprint 3A documentation
 * - Concise file manifest
 * 
 * Verifies ZIP contents programmatically before concluding.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const workspaceRoot = path.resolve(__dirname, '..', '..');
const stagingDir = path.join(workspaceRoot, 'sprint3a_deliverable_staging');
const zipPath = path.join(workspaceRoot, 'dossier-contacts-sprint-3a.zip');

console.log('📦 Starting Sprint 3A Deliverable Packaging...');
console.log(`📍 Output ZIP target: ${zipPath}\n`);

// 1. Clean previous staging or existing zip
if (fs.existsSync(stagingDir)) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
if (fs.existsSync(zipPath)) {
  fs.rmSync(zipPath, { force: true });
}

fs.mkdirSync(stagingDir, { recursive: true });

// 2. Root documentation and reports to copy
const rootFiles = [
  'SPRINT3A_COMPLETED.md',
  'TEST_RESULTS.md',
  'DEMO_SCRIPT.md',
  'DEMO_DATASET.md',
  'DEMO_RESET.md',
  'PERFORMANCE_EVALUATION_REPORT.md',
  'PERFORMANCE_EVALUATION_REPORT.json',
  'SECURITY_REGRESSION_REPORT.md',
  'SECURITY_REGRESSION_REPORT.json',
  'KNOWN_ISSUES.md',
  'SCREEN_QA.md',
  'README.md',
  'DRIE_V02_HARDENING_COMPLETED.md',
  'SPRINT1_COMPLETED.md',
  'SPRINT2_COMPLETED.md',
  'SPRINT2_CORRECTIONS_COMPLETED.md',
  'dossier_contacts.sql',
  'IDENTITY_EVALUATION_REPORT.md',
  'IDENTITY_EVALUATION_REPORT.json',
  'TEMPORAL_EVALUATION_REPORT.md',
  'TEMPORAL_EVALUATION_REPORT.json',
  'TELL_EVALUATION_REPORT.md',
  'TELL_EVALUATION_REPORT.json',
  'ASK_EVALUATION_REPORT.md',
  'ASK_EVALUATION_REPORT.json'
];

console.log('📄 Copying verified documentation and reports...');
for (const f of rootFiles) {
  const src = path.join(workspaceRoot, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(stagingDir, f));
  } else {
    console.warn(`⚠️ Warning: Expected root file not found: ${f}`);
  }
}

// Helper to recursively copy directories with strict exclusion filter
function copyDirFiltered(srcDir, destDir, excludeNames = []) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (excludeNames.includes(entry.name)) {
      continue;
    }

    // Strict exclusion: never copy .env files (only .env.example allowed)
    if (entry.name === '.env' || entry.name.endsWith('.local') || entry.name === '.env.production') {
      continue;
    }

    if (entry.isDirectory()) {
      copyDirFiltered(srcPath, destPath, excludeNames);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 3. Copy Backend
console.log('📁 Copying backend source and migrations...');
copyDirFiltered(
  path.join(workspaceRoot, 'backend'),
  path.join(stagingDir, 'backend'),
  ['node_modules', '.git', 'deliverable_staging', 'sprint3a_deliverable_staging']
);

// 4. Copy Frontend
console.log('📁 Copying frontend source and public assets...');
copyDirFiltered(
  path.join(workspaceRoot, 'frontend'),
  path.join(stagingDir, 'frontend'),
  ['node_modules', '.next', '.git', 'out', 'build']
);

// 5. Pre-compression verification scan on staging directory
console.log('🔍 Scanning staging directory for prohibited files and secrets...');
let filesScanned = 0;
function scanForForbidden(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const lower = entry.name.toLowerCase();

    // Check prohibited directory names
    if (lower === 'node_modules' || lower === '.next' || lower === '.git' || lower === '.cache') {
      throw new Error(`[SECURITY VIOLATION] Prohibited directory detected: ${fullPath}`);
    }

    // Check prohibited file names
    if (lower === '.env' || lower === '.env.local' || lower === '.env.production') {
      throw new Error(`[SECURITY VIOLATION] Secret .env file detected: ${fullPath}`);
    }

    if (entry.isDirectory()) {
      scanForForbidden(fullPath);
    } else {
      filesScanned++;
      // Check content for real leaked API keys
      if (entry.name.endsWith('.js') || entry.name.endsWith('.json') || entry.name.endsWith('.env.example')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (/AIza[0-9A-Za-z-_]{35}/.test(content)) {
          throw new Error(`[SECURITY VIOLATION] Live Google API key found in file: ${fullPath}`);
        }
        if (/sk-[a-zA-Z0-9]{32,}/.test(content)) {
          throw new Error(`[SECURITY VIOLATION] Live OpenAI API key found in file: ${fullPath}`);
        }
      }
    }
  }
}
scanForForbidden(stagingDir);
console.log(`   ✅ Staging directory scan passed: ${filesScanned} files inspected; 0 forbidden items found.\n`);

// 6. Compress staging folder into clean ZIP using .NET ZipFile
console.log('🗜️ Compressing deliverable archive into clean ZIP...');
const psScript = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory('${stagingDir.replace(/'/g, "''")}', '${zipPath.replace(/'/g, "''")}', [System.IO.Compression.CompressionLevel]::Optimal, $false)
`;
const scriptPath = path.join(workspaceRoot, '_temp_pack_sprint3a.ps1');
fs.writeFileSync(scriptPath, psScript, 'utf8');
try {
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, { stdio: 'inherit' });
} finally {
  if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
}

// 7. Cleanup staging directory
fs.rmSync(stagingDir, { recursive: true, force: true });

// 8. Programmatically verify actual ZIP entries
console.log('🔍 Programmatically verifying final ZIP contents...');
const verifyScript = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}')
$prohibitedCount = 0
$totalEntries = $zip.Entries.Count

foreach ($entry in $zip.Entries) {
    $name = $entry.FullName
    if ($name -match 'node_modules/' -or $name -match '\\.git/' -or $name -match '\\.next/' -or $name -match '(^|/)\\.env($|/)') {
        Write-Error "Prohibited entry in zip: $name"
        $prohibitedCount++
    }
}
$zip.Dispose()

if ($prohibitedCount -gt 0) {
    exit 1
} else {
    Write-Output "Verified: $totalEntries zip entries inspected. ZERO prohibited files or directories."
    exit 0
}
`;
const verifyScriptPath = path.join(workspaceRoot, '_temp_verify_zip.ps1');
fs.writeFileSync(verifyScriptPath, verifyScript, 'utf8');
try {
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${verifyScriptPath}"`, { stdio: 'inherit' });
} finally {
  if (fs.existsSync(verifyScriptPath)) fs.unlinkSync(verifyScriptPath);
}

const stats = fs.statSync(zipPath);
const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
console.log(`\n🎉 ============================================================`);
console.log(`🎉 SPRINT 3A CLEAN DELIVERABLE PACKAGE READY & VERIFIED!`);
console.log(`🎉 ============================================================`);
console.log(`📍 Archive File: ${zipPath}`);
console.log(`📦 Archive Size: ${sizeMb} MB`);
console.log(`🛡️ Verification: All excluded items (.git, node_modules, .next, .env) strictly verified absent.\n`);
