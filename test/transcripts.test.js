import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  claudeProjectDirectory,
  claudeProjectSlug,
  listClaudeTranscripts,
  listCodexTranscripts,
  resolveAgyTranscript,
  resolveAgentSessionTranscript,
  resolveBeadTranscriptIndex,
  resolveTranscriptIndex,
  resolveTranscriptPath,
} from '../dist/transcripts.js';

// Permission-denial tests rely on mode bits that root ignores.
const isRoot = process.getuid?.() === 0;

async function withTranscriptRoots(callback) {
  const home = await mkdtemp(join(tmpdir(), 'gis-transcripts-'));
  try {
    return await callback(home, {
      homeDir: home,
      maxCodexMetadataLines: 4,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("maps an absolute worktree cwd to Claude's project slug", () => {
  const cwd = '/Users/kazu/work/gis/.worktrees/gis-vst.12';
  assert.equal(
    claudeProjectSlug(cwd),
    '-Users-kazu-work-gis-.worktrees-gis-vst.12',
  );
  assert.equal(
    claudeProjectDirectory(cwd, {
      claudeProjectsDir: '/home/kazu/.claude/projects',
    }),
    '/home/kazu/.claude/projects/-Users-kazu-work-gis-.worktrees-gis-vst.12',
  );
});

test('resolves the newest Claude transcript and matching Codex session', async () => {
  await withTranscriptRoots(async (home, options) => {
    const cwd = '/repo/.worktrees/gis-vst.12';
    const claudeDirectory = claudeProjectDirectory(cwd, options);
    const codexDirectory = join(home, '.codex', 'sessions', '2026', '08', '10');
    await mkdir(claudeDirectory, { recursive: true });
    await mkdir(codexDirectory, { recursive: true });

    const claudeOld = join(claudeDirectory, 'old.jsonl');
    const claudeNewest = join(claudeDirectory, 'newest.jsonl');
    await writeFile(claudeOld, '{}\n', 'utf8');
    await writeFile(claudeNewest, '{}\n', 'utf8');
    await utimes(claudeOld, new Date(1000), new Date(1000));
    await utimes(claudeNewest, new Date(2000), new Date(2000));

    const codexOther = join(codexDirectory, 'other.jsonl');
    const codexMatch = join(codexDirectory, 'match.jsonl');
    await writeFile(
      codexOther,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/repo/other' },
      }) + '\n',
      'utf8',
    );
    await writeFile(
      codexMatch,
      JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n',
      'utf8',
    );

    assert.deepEqual(await listClaudeTranscripts(cwd, options), [
      claudeNewest,
      claudeOld,
    ]);
    assert.deepEqual(
      await listClaudeTranscripts(cwd, { ...options, modifiedAfterMs: 1500 }),
      [claudeNewest],
    );
    assert.deepEqual(await listCodexTranscripts(cwd, options), [codexMatch]);
    assert.equal(
      await resolveTranscriptPath('claude', cwd, options),
      claudeNewest,
    );
    assert.equal(
      await resolveTranscriptPath(cwd, 'codex', options),
      codexMatch,
    );

    assert.deepEqual(await resolveTranscriptIndex(cwd, options), {
      cwd: resolve(cwd),
      claude: claudeNewest,
      codex: codexMatch,
      agy: undefined,
    });
  });
});

test('resolves Antigravity conversation databases by session id and cwd', async () => {
  await withTranscriptRoots(async (home, options) => {
    const cwd = '/repo/.worktrees/gis-vst.12';
    const conversations = join(
      home,
      '.gemini',
      'antigravity-cli',
      'conversations',
    );
    const cache = join(home, '.gemini', 'antigravity-cli', 'cache');
    await mkdir(conversations, { recursive: true });
    await mkdir(cache, { recursive: true });
    const transcript = join(conversations, 'agy-session.db');
    await writeFile(transcript, 'SQLite format 3\0', 'utf8');
    await writeFile(
      join(cache, 'last_conversations.json'),
      JSON.stringify({ [resolve(cwd)]: 'agy-session' }),
      'utf8',
    );

    assert.equal(await resolveAgyTranscript(cwd, options), transcript);
    assert.equal(await resolveTranscriptPath('agy', cwd, options), transcript);
    assert.equal(
      await resolveAgentSessionTranscript(
        {
          source: 'agy-conversations',
          agent: 'agy',
          kind: 'id',
          value: 'agy-session',
        },
        cwd,
        options,
      ),
      transcript,
    );
  });
});

test('resolves the exact Claude session ID instead of the newest transcript', async () => {
  await withTranscriptRoots(async (_home, options) => {
    const cwd = '/repo/.worktrees/gis-vst.12';
    const directory = claudeProjectDirectory(cwd, options);
    await mkdir(directory, { recursive: true });
    const selected = join(directory, 'session-selected.jsonl');
    const newer = join(directory, 'session-newer.jsonl');
    await writeFile(selected, '{}\n', 'utf8');
    await writeFile(newer, '{}\n', 'utf8');
    await utimes(selected, new Date(1000), new Date(1000));
    await utimes(newer, new Date(2000), new Date(2000));

    assert.equal(
      await resolveAgentSessionTranscript(
        {
          source: 'claude-projects',
          agent: 'claude',
          kind: 'id',
          value: 'session-selected',
        },
        cwd,
        options,
      ),
      selected,
    );
  });
});

test('resolves the exact Codex session ID and validates its cwd', async () => {
  await withTranscriptRoots(async (home, options) => {
    const cwd = '/repo/.worktrees/gis-vst.12';
    const directory = join(home, '.codex', 'sessions', '2026', '08', '10');
    await mkdir(directory, { recursive: true });
    const selected = join(
      directory,
      'rollout-2026-08-10-session-selected.jsonl',
    );
    const sameCwd = join(directory, 'rollout-2026-08-10-session-newer.jsonl');
    const wrongCwd = join(
      directory,
      'rollout-2026-08-10-session-wrong-cwd.jsonl',
    );
    await writeFile(
      selected,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-selected', cwd },
      }) + '\n',
      'utf8',
    );
    await writeFile(
      sameCwd,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-newer', cwd },
      }) + '\n',
      'utf8',
    );
    await writeFile(
      wrongCwd,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-wrong-cwd', cwd: '/repo/other' },
      }) + '\n',
      'utf8',
    );

    assert.equal(
      await resolveAgentSessionTranscript(
        {
          source: 'codex-sessions',
          agent: 'codex',
          kind: 'id',
          value: 'session-selected',
        },
        cwd,
        options,
      ),
      selected,
    );
    assert.equal(
      await resolveAgentSessionTranscript(
        {
          source: 'codex-sessions',
          agent: 'codex',
          kind: 'id',
          value: 'session-wrong-cwd',
        },
        cwd,
        options,
      ),
      undefined,
    );
  });
});

test('does not choose between duplicate Codex files for the same session', async () => {
  await withTranscriptRoots(async (home, options) => {
    const cwd = '/repo/.worktrees/gis-vst.12';
    const firstDirectory = join(home, '.codex', 'sessions', '2026', '08', '10');
    const secondDirectory = join(
      home,
      '.codex',
      'sessions',
      '2026',
      '08',
      '11',
    );
    await mkdir(firstDirectory, { recursive: true });
    await mkdir(secondDirectory, { recursive: true });
    const metadata =
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'duplicate-session', cwd },
      }) + '\n';
    await writeFile(
      join(firstDirectory, 'rollout-first-duplicate-session.jsonl'),
      metadata,
    );
    await writeFile(
      join(secondDirectory, 'rollout-second-duplicate-session.jsonl'),
      metadata,
    );

    assert.equal(
      await resolveAgentSessionTranscript(
        {
          source: 'codex-sessions',
          agent: 'codex',
          kind: 'id',
          value: 'duplicate-session',
        },
        cwd,
        options,
      ),
      undefined,
    );
  });
});

test('uses a path session reference directly', async () => {
  await withTranscriptRoots(async (home, options) => {
    const cwd = '/repo/.worktrees/gis-vst.12';
    const transcript = join(home, 'custom', 'session.jsonl');
    await mkdir(join(home, 'custom'), { recursive: true });
    await writeFile(transcript, '{}\n', 'utf8');

    assert.equal(
      await resolveAgentSessionTranscript(
        {
          source: 'pi',
          agent: 'pi',
          kind: 'path',
          value: transcript,
        },
        cwd,
        options,
      ),
      transcript,
    );
  });
});

test('associates a bead and worktree with a runner transcript without copying logs', async () => {
  await withTranscriptRoots(async (home, options) => {
    const cwd = '/repo/.worktrees/gis-vst.12';
    const sessions = join(home, '.codex', 'sessions', '2026');
    const transcript = join(sessions, 'rollout.jsonl');
    await mkdir(sessions, { recursive: true });
    await writeFile(
      transcript,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd },
      }) + '\n',
      'utf8',
    );

    assert.deepEqual(
      await resolveBeadTranscriptIndex('gis-vst.12', cwd, 'codex', options),
      {
        beadId: 'gis-vst.12',
        worktreePath: resolve(cwd),
        kind: 'codex',
        transcriptPath: transcript,
      },
    );
  });
});

test('returns no index when the official transcript roots have no matching file', async () => {
  await withTranscriptRoots(async (_home, options) => {
    assert.deepEqual(
      await resolveTranscriptIndex('/repo/.worktrees/missing', options),
      {
        cwd: '/repo/.worktrees/missing',
        claude: undefined,
        codex: undefined,
        agy: undefined,
      },
    );
    assert.equal(
      await resolveBeadTranscriptIndex(
        'gis-vst.12',
        '/repo/.worktrees/missing',
        'claude',
        options,
      ),
      undefined,
    );
  });
});

test('rejects empty or non-string identifiers', async () => {
  await withTranscriptRoots(async (home, options) => {
    assert.throws(() => claudeProjectSlug(''), TypeError);
    assert.throws(() => claudeProjectSlug('   '), TypeError);
    assert.throws(() => claudeProjectSlug(42), TypeError);
    await assert.rejects(
      resolveBeadTranscriptIndex('', join(home, 'wt'), 'claude', options),
      TypeError,
    );
  });
});

test('rejects an invalid maxCodexMetadataLines override', async () => {
  await withTranscriptRoots(async (_home, options) => {
    const cwd = '/repo/.worktrees/gis-vst.12';
    await assert.rejects(
      listCodexTranscripts(cwd, { ...options, maxCodexMetadataLines: 0 }),
      RangeError,
    );
    await assert.rejects(
      listCodexTranscripts(cwd, { ...options, maxCodexMetadataLines: 1.5 }),
      RangeError,
    );
  });
});

test('rejects an invalid modifiedAfterMs override', async () => {
  await withTranscriptRoots(async (_home, options) => {
    const cwd = '/repo/.worktrees/gis-vst.12';
    await assert.rejects(
      listClaudeTranscripts(cwd, { ...options, modifiedAfterMs: -1 }),
      RangeError,
    );
    await assert.rejects(
      listClaudeTranscripts(cwd, { ...options, modifiedAfterMs: NaN }),
      RangeError,
    );
  });
});

test('returns undefined for a path session reference that does not exist', async () => {
  await withTranscriptRoots(async (home, options) => {
    const cwd = '/repo/.worktrees/gis-vst.12';
    const missing = join(home, 'custom', 'missing.jsonl');

    assert.equal(
      await resolveAgentSessionTranscript(
        { source: 'pi', agent: 'pi', kind: 'path', value: missing },
        cwd,
        options,
      ),
      undefined,
    );
  });
});

test('propagates a non-missing-path error while checking a path session reference', async (t) => {
  if (isRoot) {
    t.skip('permission bits do not block root');
    return;
  }
  await withTranscriptRoots(async (home, options) => {
    const cwd = '/repo/.worktrees/gis-vst.12';
    const blockedDir = join(home, 'blocked');
    await mkdir(blockedDir, { recursive: true });
    await writeFile(join(blockedDir, 'session.jsonl'), '{}\n', 'utf8');
    await chmod(blockedDir, 0o600);
    try {
      await assert.rejects(
        resolveAgentSessionTranscript(
          {
            source: 'pi',
            agent: 'pi',
            kind: 'path',
            value: join(blockedDir, 'session.jsonl'),
          },
          cwd,
          options,
        ),
        (error) => error.code === 'EACCES',
      );
    } finally {
      await chmod(blockedDir, 0o700);
    }
  });
});

test('propagates a non-missing-path error while listing Claude transcripts', async (t) => {
  if (isRoot) {
    t.skip('permission bits do not block root');
    return;
  }
  await withTranscriptRoots(async (_home, options) => {
    const cwd = '/repo/.worktrees/gis-vst.12';
    const directory = claudeProjectDirectory(cwd, options);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'session.jsonl'), '{}\n', 'utf8');
    await chmod(directory, 0o600);
    try {
      await assert.rejects(
        listClaudeTranscripts(cwd, options),
        (error) => error.code === 'EACCES',
      );
    } finally {
      await chmod(directory, 0o700);
    }
  });
});

test('propagates a non-missing-path error while matching Codex sessions', async (t) => {
  if (isRoot) {
    t.skip('permission bits do not block root');
    return;
  }
  await withTranscriptRoots(async (home, options) => {
    const cwd = '/repo/.worktrees/gis-vst.12';
    const directory = join(home, '.codex', 'sessions', '2026', '08', '10');
    await mkdir(directory, { recursive: true });
    const transcript = join(directory, 'rollout.jsonl');
    await writeFile(
      transcript,
      JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n',
      'utf8',
    );
    // Deny read on the file itself (not its directory) so `stat` -- and thus
    // `timestampedFiles` -- still succeeds; only the later content read
    // inside `matchingCodexFiles` should fail.
    await chmod(transcript, 0o000);
    try {
      await assert.rejects(
        listCodexTranscripts(cwd, options),
        (error) => error.code === 'EACCES',
      );
    } finally {
      await chmod(transcript, 0o700);
    }
  });
});

test('skips malformed Codex records when locating a matching cwd or session id', async () => {
  await withTranscriptRoots(async (home, options) => {
    const cwd = '/repo/.worktrees/gis-vst.12';
    const directory = join(home, '.codex', 'sessions', '2026', '08', '10');
    await mkdir(directory, { recursive: true });
    const lines = [
      'null',
      '{}',
      JSON.stringify({ type: 'session_meta' }),
      'not-json-at-all',
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'sess-x', cwd },
      }),
    ];
    const file = join(directory, 'rollout-sess-x.jsonl');
    await writeFile(file, lines.join('\n') + '\n', 'utf8');

    const wideOptions = { ...options, maxCodexMetadataLines: 5 };
    assert.deepEqual(await listCodexTranscripts(cwd, wideOptions), [file]);
    assert.equal(
      await resolveAgentSessionTranscript(
        {
          source: 'codex-sessions',
          agent: 'codex',
          kind: 'id',
          value: 'sess-x',
        },
        cwd,
        wideOptions,
      ),
      file,
    );
  });
});

test('treats an empty Codex session cwd as absent rather than a match', async () => {
  await withTranscriptRoots(async (home, options) => {
    const cwd = '/repo/.worktrees/gis-vst.12';
    const directory = join(home, '.codex', 'sessions', '2026', '08', '10');
    await mkdir(directory, { recursive: true });
    const file = join(directory, 'rollout.jsonl');
    // The empty-cwd record must be skipped as if it had no cwd at all --
    // if it were treated as a real match, `absoluteCwd('')` would throw
    // instead of the scan moving on to the record that actually matches.
    await writeFile(
      file,
      [
        JSON.stringify({ type: 'session_meta', payload: { cwd: '' } }),
        JSON.stringify({ type: 'session_meta', payload: { cwd } }),
      ].join('\n') + '\n',
      'utf8',
    );

    assert.deepEqual(await listCodexTranscripts(cwd, options), [file]);
  });
});

test('gives up once the metadata line limit is reached without a match', async () => {
  await withTranscriptRoots(async (home, options) => {
    const cwd = '/repo/.worktrees/gis-vst.12';
    const directory = join(home, '.codex', 'sessions', '2026', '08', '10');
    await mkdir(directory, { recursive: true });
    // Neither a `session_meta` record nor a payload with a `cwd`, so both
    // extractors must keep scanning through these.
    const nonMatching = JSON.stringify({ payload: { note: 'irrelevant' } });
    // Matches both extractors (cwd for the listing, id for the lookup) --
    // placed on line 5, past the `maxCodexMetadataLines` (4) cutoff in
    // `options`, so a correct scan must give up just before reaching it.
    // If the cutoff were off-by-one or skipped entirely, this record would
    // be found and the assertions below would fail.
    const wouldMatch = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'sess-y', cwd },
    });
    const file = join(directory, 'rollout-sess-y.jsonl');
    await writeFile(
      file,
      [nonMatching, nonMatching, nonMatching, nonMatching, wouldMatch].join(
        '\n',
      ) + '\n',
      'utf8',
    );

    assert.deepEqual(await listCodexTranscripts(cwd, options), []);
    assert.equal(
      await resolveAgentSessionTranscript(
        {
          source: 'codex-sessions',
          agent: 'codex',
          kind: 'id',
          value: 'sess-y',
        },
        cwd,
        options,
      ),
      undefined,
    );
  });
});

test('resolves ~ and ~/ path session references against the home directory', async () => {
  await withTranscriptRoots(async (home, options) => {
    const cwd = join(home, 'worktree');
    await mkdir(cwd, { recursive: true });
    // A decoy at the literal, non-expanded path `${cwd}/~`. If `~` were
    // ever treated as an ordinary relative path segment instead of being
    // expanded to the home directory, this decoy file would be resolved
    // instead of the (non-file) home directory, making the two branches
    // distinguishable.
    await writeFile(join(cwd, '~'), '{}\n', 'utf8');

    assert.equal(
      await resolveAgentSessionTranscript(
        { source: 'pi', agent: 'pi', kind: 'path', value: '~' },
        cwd,
        options,
      ),
      undefined,
    );

    await mkdir(join(home, 'custom'), { recursive: true });
    const transcript = join(home, 'custom', 'session.jsonl');
    await writeFile(transcript, '{}\n', 'utf8');
    assert.equal(
      await resolveAgentSessionTranscript(
        {
          source: 'pi',
          agent: 'pi',
          kind: 'path',
          value: '~/custom/session.jsonl',
        },
        cwd,
        options,
      ),
      transcript,
    );
  });
});

test('rejects an agent session reference of an unsupported kind', async () => {
  await withTranscriptRoots(async (_home, options) => {
    const cwd = '/repo/.worktrees/gis-vst.12';
    await assert.rejects(
      resolveAgentSessionTranscript(
        { source: 'pi', agent: 'pi', kind: 'hash', value: 'abc' },
        cwd,
        options,
      ),
      TypeError,
    );
  });
});

test('returns undefined for an id session reference from an unsupported agent', async () => {
  await withTranscriptRoots(async (_home, options) => {
    const cwd = '/repo/.worktrees/gis-vst.12';
    assert.equal(
      await resolveAgentSessionTranscript(
        { source: 'pi', agent: 'pi', kind: 'id', value: 'abc' },
        cwd,
        options,
      ),
      undefined,
    );
  });
});

test('rejects an unsupported transcript kind', async () => {
  await withTranscriptRoots(async (_home, options) => {
    await assert.rejects(
      resolveTranscriptPath('/repo/.worktrees/gis-vst.12', 'bogus', options),
      TypeError,
    );
  });
});
