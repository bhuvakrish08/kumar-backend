/**
 * Automated Deliverable Packaging Script (v0.2 Hardening)
 *
 * Copies verified application code, migrations, tests, reports, and documentation
 * to staging, verifies strict exclusion of forbidden items (.git, node_modules, .next, .env, secrets),
 * and generates a clean ZIP deliverable.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const workspaceRoot = path.resolve(__dirname, '..', '..');
const stagingDir = path.join(workspaceRoot, 'deliverable_staging');
const zipPath = path.join(workspaceRoot, 'dossier-contacts-drie-v0.2.zip');

console.log('📦 Preparing clean deliverable package at:', zipPath);

// 1. Clean previous staging or zip
if (fs.existsSync(stagingDir)) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
if (fs.existsSync(zipPath)) {
  fs.rmSync(zipPath, { force: true });
}

fs.mkdirSync(stagingDir, { recursive: true });

// 2. Root files to copy
const rootFiles = [
  'DRIE_V02_HARDENING_COMPLETED.md',
  'TEST_RESULTS.md',
  'KNOWN_ISSUES.md',
  'README.md',
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
  'ASK_EVALUATION_REPORT.json',
  'SECURITY_REGRESSION_REPORT.md',
  'SECURITY_REGRESSION_REPORT.json',
  'PERFORMANCE_EVALUATION_REPORT.md',
  'PERFORMANCE_EVALUATION_REPORT.json'
];

for (const f of rootFiles) {
  const src = path.join(workspaceRoot, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(stagingDir, f));
  } else {
    console.warn('⚠️ Warning: File not found:', f);
  }
}

// Helper to recursively copy directories with exclusion filter
function copyDirFiltered(srcDir, destDir, excludeNames = []) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (excludeNames.includes(entry.name)) {
      continue;
    }
    // Strict exclusion: never copy .env unless it is .env.example
    if (entry.name === '.env') {
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
console.log('  Copying backend...');
copyDirFiltered(
  path.join(workspaceRoot, 'backend'),
  path.join(stagingDir, 'backend'),
  ['node_modules', '.git']
);

// 4. Copy Frontend
console.log('  Copying frontend...');
copyDirFiltered(
  path.join(workspaceRoot, 'frontend'),
  path.join(stagingDir, 'frontend'),
  ['node_modules', '.next', '.git']
);

// 5. Verification scan on staging directory
console.log('  Verifying exclusions...');
function scanForForbidden(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') {
      throw new Error(`Forbidden directory found in deliverable: ${fullPath}`);
    }
    if (entry.name === '.env') {
      throw new Error(`Forbidden file found in deliverable: ${fullPath}`);
    }
    if (entry.isDirectory()) {
      scanForForbidden(fullPath);
    }
  }
}
scanForForbidden(stagingDir);

// 6. Compress staging folder into ZIP using .NET ZipFile (immune to parentheses in path)
console.log('🗜️ Compressing deliverable archive into ZIP...');
const psScript = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory('${stagingDir.replace(/'/g, "''")}', '${zipPath.replace(/'/g, "''")}', [System.IO.Compression.CompressionLevel]::Optimal, $false)
`;
const scriptPath = path.join(workspaceRoot, '_temp_zip.ps1');
fs.writeFileSync(scriptPath, psScript, 'utf8');
try {
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, { stdio: 'inherit' });
} finally {
  if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
}

// 7. Cleanup staging directory
fs.rmSync(stagingDir, { recursive: true, force: true });

const stats = fs.statSync(zipPath);
const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
console.log(`\n🎉 Deliverable ZIP created successfully!`);
console.log(`📍 Path: ${zipPath}`);
console.log(`📦 Size: ${sizeMb} MB\n`);
