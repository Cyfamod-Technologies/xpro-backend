import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');
const CAST = ['::', 'uuid'].join('');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(entry.name) &&
      !/\.(spec|int-spec|e2e-spec)\.ts$/.test(entry.name)
      ? [path]
      : [];
  });
}

describe('request id comparisons', () => {
  it('never cast a text id to uuid in src (service_requests.id is TEXT)', () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      readFileSync(file, 'utf8').includes(CAST),
    );
    expect(offenders).toEqual([]);
  });
});
