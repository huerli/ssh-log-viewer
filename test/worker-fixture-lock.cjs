// These fixtures deliberately use the production worker argv. Serialize the
// two process suites so direct-worker discovery cannot see the other suite.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
async function acquireWorkerFixtureLock() {
  const directory = path.join(os.tmpdir(), `viewer-worker-fixtures-${process.getuid?.() ?? os.userInfo().username}.lock`);
  const owner = path.join(directory, 'owner');
  const deadline = Date.now() + 60000;
  while (true) {
    try {
      await fs.mkdir(directory);
      try { await fs.writeFile(owner, String(process.pid)); }
      catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
      return () => fs.rm(directory, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await fs.readFile(owner, 'utf8').catch(() => ''));
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); }
        catch (probe) {
          if (probe.code === 'ESRCH') { await fs.rm(directory, { recursive: true, force: true }); continue; }
        }
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for isolated worker process fixtures');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
module.exports = { acquireWorkerFixtureLock };
