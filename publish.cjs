'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const repository = 'rayyanjsmj/noring-releases';
const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' };
async function request(route, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}${route}`, { ...options, headers: { ...headers, 'Content-Type': 'application/json', ...options.headers } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Release operation failed (${response.status}).`);
  return response.json();
}
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function upload(release, filename, file, expectedHash) {
  const size = fs.statSync(file).size;
  const existing = release.assets.find((asset) => asset.name === filename);
  if (existing) {
    if (existing.size !== size || existing.digest !== `sha256:${expectedHash}`) throw new Error('An existing release asset has a different checksum. It was preserved.');
    return existing;
  }
  const response = await fetch(`${release.upload_url.split('{')[0]}?name=${encodeURIComponent(filename)}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
    body: fs.createReadStream(file), duplex: 'half'
  });
  if (!response.ok) throw new Error(`Installer upload failed (${response.status}).`);
  const asset = await response.json();
  if (asset.size !== size || asset.digest !== `sha256:${expectedHash}`) throw new Error('Uploaded installer checksum did not match.');
  console.log(`Verified ${filename}`);
  return asset;
}
async function main() {
  if (process.env.GITHUB_REPOSITORY !== repository) throw new Error('Unexpected release repository.');
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH));
  const spec = JSON.parse(event.inputs.transfer);
  if (!/^\d+\.\d+\.\d+$/.test(spec.version) || !/^[a-f0-9]{40}$/.test(spec.commit)
    || !Array.isArray(spec.artifacts) || spec.artifacts.length !== 4) throw new Error('Invalid transfer specification.');
  const expectedTargets = ['win-it', 'win-student', 'mac-it', 'mac-student'];
  if (new Set(spec.artifacts.map((item) => item.target)).size !== 4) throw new Error('Duplicate transfer target.');
  for (const item of spec.artifacts) {
    const url = new URL(item.url);
    if (!expectedTargets.includes(item.target) || url.protocol !== 'https:' || url.username || url.password
      || !(url.hostname.endsWith('.blob.core.windows.net') || url.hostname.endsWith('.actions.githubusercontent.com'))
      || !/^sha256:[a-f0-9]{64}$/.test(item.digest)) throw new Error('Invalid artifact reference.');
    console.log(`::add-mask::${item.url}`);
  }
  let release = await request(`/releases/tags/v${spec.version}`);
  if (!release) release = await request('/releases', { method: 'POST', body: JSON.stringify({
    tag_name: `v${spec.version}`, name: `Noring ${spec.version}`, draft: true,
    body: 'Desktop IT/Manager and Student installers. Fixes notification clock differences, overlay renderer recovery, and machine-wide Student enrollment across Windows domain logins. Automated protocol and packaging checks passed; physical StarBoard validation is still required. Windows builds are unsigned and Mac builds are unsigned and not notarized. Android APK downloads remain unchanged.'
  }) });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noring-transfer-'));
  const installers = [];
  for (const item of spec.artifacts) {
    const folder = path.join(root, item.target); fs.mkdirSync(folder);
    const zip = path.join(folder, 'package.zip');
    const response = await fetch(item.url);
    if (!response.ok) throw new Error('Temporary build download failed.');
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(zip, { flags: 'wx' }));
    if (sha(zip) !== item.digest.slice(7)) throw new Error('Build archive checksum did not match.');
    execFileSync('python3', ['-c',
      'import zipfile,sys,pathlib,stat\nz=zipfile.ZipFile(sys.argv[1]);out=pathlib.Path(sys.argv[2]);items=z.infolist()\nassert len(items)==2\nfor i in items:\n assert "/" not in i.filename and ".." not in i.filename and i.file_size < 200_000_000 and not stat.S_ISLNK(i.external_attr >> 16)\n z.extract(i,out)\n', zip, folder]);
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json')));
    const win = item.target.startsWith('win-');
    const role = item.target.endsWith('-it') ? 'server' : 'display';
    if (manifest.version !== spec.version || manifest.commit !== spec.commit || manifest.role !== role
      || manifest.platform !== (win ? 'win32' : 'darwin') || path.basename(manifest.file) !== manifest.file) throw new Error('Embedded build manifest mismatch.');
    const file = path.join(folder, manifest.file);
    if (fs.statSync(file).size !== manifest.bytes || sha(file) !== manifest.sha256) throw new Error('Installer checksum did not match.');
    const filename = `noring${role === 'server' ? '-manager' : ''}-${win ? 'windows' : 'macos-intel'}-${spec.version}.${win ? 'exe' : 'dmg'}`;
    const asset = await upload(release, filename, file, manifest.sha256);
    installers.push({ ...manifest, file: filename, url: asset.browser_download_url });
    fs.rmSync(folder, { recursive: true });
  }
  const manifestFile = path.join(root, 'release-manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ version: spec.version, release: release.html_url, installers }, null, 2));
  await upload(release, 'release-manifest.json', manifestFile, sha(manifestFile));
  if (release.draft) await request(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false }) });
  console.log(`Published ${release.html_url}`);
}
main().catch(() => { console.error('Installer publication failed. Check package checksums, temporary artifact expiry, and repository permissions. Existing release assets were preserved.'); process.exitCode = 1; });
