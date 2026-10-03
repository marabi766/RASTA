import fs from 'node:fs';

it('reads through a link that lives outside the repository', () => {
  fs.readFileSync(String(process.env.FIXTURE_SYMLINK));
});
