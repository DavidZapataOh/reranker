-- The signing keys pinned in @reranker/verify (KEYS_BY_ENV), so the database records every key
-- that ever signed evidence. Preview logs sign under one origin per deployment, so only the
-- production log key has a single signed-note verifier key.
insert into public_panel.signing_keys
  (keyid, purpose, env, public_key, custody, valid_from, valid_to, compromised_after, note_vkey)
values
  (
    'rr-capture-2026-1-ed25519', 'capture', 'production',
    '\x573403f2226bb0eb99890c7a091d054d0560f4fb154b880a824bffe63801ae32', 'aws-kms-hsm',
    '2026-11-20T18:29:31.132Z', null, null, null
  ),
  (
    'rr-log-2026-1', 'log', 'production',
    '\xd05b44ac8ebe0c73279ef426cb2956394896c0b2c178eed74f9319a57c367bc0', 'aws-kms-hsm',
    '2026-11-20T18:29:31.600Z', null, null,
    'log.reranker.co/captures/2026+911d430c+AdBbRKyOvgxzJ570JsspVjlIlsCywXju10+TGaV8NnvA'
  ),
  (
    'rr-capture-preview-2026-1-ed25519', 'capture', 'preview',
    '\x6395911af3b3c0c0f71c6683cc9657ae3186bc492fa68132134bfceb9a609c97', 'aws-kms-hsm',
    '2026-11-20T18:29:31.957Z', null, null, null
  ),
  (
    'rr-log-preview-2026-1', 'log', 'preview',
    '\x6533d8c62ca6f187c5b7bbebd7f2bc6c9bba8b89d2c98d719e2159ad9f5e9965', 'aws-kms-hsm',
    '2026-11-20T18:29:32.321Z', null, null, null
  );
