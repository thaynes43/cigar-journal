# Changelog

## [0.32.1](https://github.com/thaynes43/cigar-journal/compare/v0.32.0...v0.32.1) (2026-08-31)


### Bug Fixes

* **crawler:** approved-list import never asserts a market focus ([#210](https://github.com/thaynes43/cigar-journal/issues/210)) ([#225](https://github.com/thaynes43/cigar-journal/issues/225)) ([21d28a4](https://github.com/thaynes43/cigar-journal/commit/21d28a43b6f02752658d110f2e823d299ec0c099))
* **domain:** malformed external ids answer as not-found everywhere ([#206](https://github.com/thaynes43/cigar-journal/issues/206)) ([#228](https://github.com/thaynes43/cigar-journal/issues/228)) ([dd23d2a](https://github.com/thaynes43/cigar-journal/commit/dd23d2a33036b04bfbc7af0538912913e6cd876c))
* **taxonomy:** mint emits folded alias keys only; clean legacy keys and Padrón's slug (migration 0029) ([#227](https://github.com/thaynes43/cigar-journal/issues/227)) ([a2b0b9e](https://github.com/thaynes43/cigar-journal/commit/a2b0b9e0af058a61dedf85ec22e4f7cd7043f12d))

## [0.32.0](https://github.com/thaynes43/cigar-journal/compare/v0.31.1...v0.32.0) (2026-08-31)


### Features

* **reviews:** review observations, source kinds, blend aggregates (migration 0028, ADR-013 slice 1) ([#222](https://github.com/thaynes43/cigar-journal/issues/222)) ([dcebdb1](https://github.com/thaynes43/cigar-journal/commit/dcebdb1531971136965842e0b6960c0d681e1982))

## [0.31.1](https://github.com/thaynes43/cigar-journal/compare/v0.31.0...v0.31.1) (2026-08-31)


### Bug Fixes

* **taxonomy:** mint-time slugs fold accents — clean URL keys for new registry rows ([#220](https://github.com/thaynes43/cigar-journal/issues/220)) ([27f9f0b](https://github.com/thaynes43/cigar-journal/commit/27f9f0be3c54c5c034879f90b71a4f6d3680cab8))

## [0.31.0](https://github.com/thaynes43/cigar-journal/compare/v0.30.0...v0.31.0) (2026-08-31)


### Features

* **mcp:** taxonomy curation verbs — registry minting, assignment, worklists (ADR-012 Wave 3) ([#214](https://github.com/thaynes43/cigar-journal/issues/214)) ([1d77916](https://github.com/thaynes43/cigar-journal/commit/1d77916339fba38a81c8f0f16adabfdaeb4dd8e5))
* **web:** catalog hierarchy and slicing (DESIGN-004, ADR-012 Wave 4) ([#215](https://github.com/thaynes43/cigar-journal/issues/215)) ([acddde5](https://github.com/thaynes43/cigar-journal/commit/acddde5531bdb57373bccdcfec1942909295a023))

## [0.30.0](https://github.com/thaynes43/cigar-journal/compare/v0.29.0...v0.30.0) (2026-08-31)


### Features

* **catalog:** matching v2 — alias-anchored resolution and structured write paths (migration 0027, ADR-012 Wave 2) ([#212](https://github.com/thaynes43/cigar-journal/issues/212)) ([a7e950a](https://github.com/thaynes43/cigar-journal/commit/a7e950a452b50f440ea97ecf98e0563af5f7af93))

## [0.29.0](https://github.com/thaynes43/cigar-journal/compare/v0.28.1...v0.29.0) (2026-08-31)


### Features

* **db:** taxonomy registries — brands, lines, blends, blenders (migration 0026, ADR-012) ([#208](https://github.com/thaynes43/cigar-journal/issues/208)) ([94d39df](https://github.com/thaynes43/cigar-journal/commit/94d39df1009cc4efcce2bbf99ab87dca67b46913))


### Bug Fixes

* **enrichment:** evidenced market, write authority, lane lock, per-request liveness ([#170](https://github.com/thaynes43/cigar-journal/issues/170), [#157](https://github.com/thaynes43/cigar-journal/issues/157), [#155](https://github.com/thaynes43/cigar-journal/issues/155), [#185](https://github.com/thaynes43/cigar-journal/issues/185)) ([#192](https://github.com/thaynes43/cigar-journal/issues/192)) ([88196bc](https://github.com/thaynes43/cigar-journal/commit/88196bc8fb44000b664b5e31d3a79cedf8c2ddf7))
* **mcp,web:** malformed-id 404s on delete/get_smoke; strict published photo schema ([#202](https://github.com/thaynes43/cigar-journal/issues/202) exp 1) ([#204](https://github.com/thaynes43/cigar-journal/issues/204)) ([9177a1c](https://github.com/thaynes43/cigar-journal/commit/9177a1cc27ee151fe0825010e9ebe263b3e23b94))
* **mcp:** gap-fill invariant per [#177](https://github.com/thaynes43/cigar-journal/issues/177) ruling — two-call primary, entry never traded for enrichment ([#188](https://github.com/thaynes43/cigar-journal/issues/188)) ([54176cb](https://github.com/thaynes43/cigar-journal/commit/54176cb8232d13b6324cd4f8c448c58367f7ac74))

## [0.28.1](https://github.com/thaynes43/cigar-journal/compare/v0.28.0...v0.28.1) (2026-08-31)


### Bug Fixes

* **crawler:** bound brand-image downloads before buffering ([#197](https://github.com/thaynes43/cigar-journal/issues/197)) ([be15ac1](https://github.com/thaynes43/cigar-journal/commit/be15ac17021941241fedeb5db2c6c61aba988ed3))
* **mcp:** upload link is the photo flow — validate before consuming, 24h TTL, honest errors ([#203](https://github.com/thaynes43/cigar-journal/issues/203)) ([b212674](https://github.com/thaynes43/cigar-journal/commit/b21267451ec10a4c4698681c42167db18457d606))
* **web:** agent-run console pages past 100 rows ([#173](https://github.com/thaynes43/cigar-journal/issues/173)) ([#194](https://github.com/thaynes43/cigar-journal/issues/194)) ([d3ddfe5](https://github.com/thaynes43/cigar-journal/commit/d3ddfe5616947322c4705e2dc1b1df6451404001))
* **web:** malformed public ids 404; journal photo caching becomes revocable ([#200](https://github.com/thaynes43/cigar-journal/issues/200)) ([483b4e8](https://github.com/thaynes43/cigar-journal/commit/483b4e8bda0b05c1d0113d1903180d080c2ac5ad))

## [0.28.0](https://github.com/thaynes43/cigar-journal/compare/v0.27.1...v0.28.0) (2026-08-30)


### Features

* **crawler:** per-vendor enrichment budgets — a vendor's catalogue is partial ([#158](https://github.com/thaynes43/cigar-journal/issues/158)) ([#181](https://github.com/thaynes43/cigar-journal/issues/181)) ([25358e5](https://github.com/thaynes43/cigar-journal/commit/25358e548a63e8ffb2977e04fdb6a0e61076a5fd))
* **oauth:** mint curation-scoped service tokens behind --allow-curation ([#178](https://github.com/thaynes43/cigar-journal/issues/178)) ([6467b25](https://github.com/thaynes43/cigar-journal/commit/6467b259ffc4c39c04628e8596b35517b591b30a))


### Bug Fixes

* **crawler:** 2 Guys product gate matches gift-registry pages ([#179](https://github.com/thaynes43/cigar-journal/issues/179)) ([c09dba8](https://github.com/thaynes43/cigar-journal/commit/c09dba8f138eed3c1972ea8a153234f280cb52c4))
* **db:** swallow the embedded-Postgres teardown race that failed green runs ([#180](https://github.com/thaynes43/cigar-journal/issues/180)) ([6b07b22](https://github.com/thaynes43/cigar-journal/commit/6b07b22fbb725ddc24ed130f66866e3874dc66bf))
* **mcp:** diagnose add_smoke_photo delivery instead of silently falling back ([#184](https://github.com/thaynes43/cigar-journal/issues/184)) ([a0d8390](https://github.com/thaynes43/cigar-journal/commit/a0d8390587903e0888c1602d327d30f7009ec81f))

## [0.27.1](https://github.com/thaynes43/cigar-journal/compare/v0.27.0...v0.27.1) (2026-08-30)


### Bug Fixes

* **web:** acknowledge a display-name save and refresh the header at once ([#175](https://github.com/thaynes43/cigar-journal/issues/175)) ([ba291c4](https://github.com/thaynes43/cigar-journal/commit/ba291c484c2845289d2fb5aba56a94bd1baad089))

## [0.27.0](https://github.com/thaynes43/cigar-journal/compare/v0.26.1...v0.27.0) (2026-08-30)


### Features

* Authentik OIDC sign-in + invite system ([#46](https://github.com/thaynes43/cigar-journal/issues/46)) ([#168](https://github.com/thaynes43/cigar-journal/issues/168)) ([7d03d96](https://github.com/thaynes43/cigar-journal/commit/7d03d96d4787405dd47f784e3a767e8d36d81fe0))
* **catalog:** Wikidata brand imagery as wall-cover fallback ([#127](https://github.com/thaynes43/cigar-journal/issues/127)) ([#163](https://github.com/thaynes43/cigar-journal/issues/163)) ([b872fa0](https://github.com/thaynes43/cigar-journal/commit/b872fa09a9a6cab6ff7210e42e9569c385026926))
* **crawler:** sitemap sampling, root-slug product gate, multi-sample probe ([#127](https://github.com/thaynes43/cigar-journal/issues/127)) ([#160](https://github.com/thaynes43/cigar-journal/issues/160)) ([e821982](https://github.com/thaynes43/cigar-journal/commit/e821982d4c674514d9338b7879d4fed7e6861156))
* **curation:** bulk-enqueue enrichment for photoless holdings ([#167](https://github.com/thaynes43/cigar-journal/issues/167)) ([5f58213](https://github.com/thaynes43/cigar-journal/commit/5f58213b016d75033a06b4ff85de61f08aa3abfa))
* **curation:** unmerge bookkeeping + rename undo ([#45](https://github.com/thaynes43/cigar-journal/issues/45)) ([#162](https://github.com/thaynes43/cigar-journal/issues/162)) ([6e7c6d1](https://github.com/thaynes43/cigar-journal/commit/6e7c6d1d0ce158a2764e58ac2d915bfebd905128))
* **oauth:** operator-minted service tokens for browserless MCP clients ([#129](https://github.com/thaynes43/cigar-journal/issues/129)) ([#165](https://github.com/thaynes43/cigar-journal/issues/165)) ([ab58810](https://github.com/thaynes43/cigar-journal/commit/ab588102c6390cf0043bd1481dfa74b3a0487ada))


### Bug Fixes

* **web:** measured tobacco ramp, seal fit, chip legibility ([#49](https://github.com/thaynes43/cigar-journal/issues/49)) ([#171](https://github.com/thaynes43/cigar-journal/issues/171)) ([946ae6a](https://github.com/thaynes43/cigar-journal/commit/946ae6ac8e5f2fda315bcbd4c812f75c630943ad))

## [0.26.1](https://github.com/thaynes43/cigar-journal/compare/v0.26.0...v0.26.1) (2026-08-29)


### Bug Fixes

* **crawler:** probe-informed adapter corrections — 2 Guys /store/, Cuban Lou's product-only sitemap ([#150](https://github.com/thaynes43/cigar-journal/issues/150)) ([0c0a321](https://github.com/thaynes43/cigar-journal/commit/0c0a3216ab0ae88c892365e9ede7974282272c58))

## [0.26.0](https://github.com/thaynes43/cigar-journal/compare/v0.25.1...v0.26.0) (2026-08-29)


### Features

* **crawler:** vendor expansion — 2 Guys, Small Batch, Cuban Lou's (no-linkout posture), decided_by guard, approved-list import ([#127](https://github.com/thaynes43/cigar-journal/issues/127)) ([#147](https://github.com/thaynes43/cigar-journal/issues/147)) ([d0fa2ef](https://github.com/thaynes43/cigar-journal/commit/d0fa2ef0ba165adc38a36868fae9cbb4bced02ec))
* **ops:** Playwright e2e suite — auth, catalog, journal, admin, public ([#48](https://github.com/thaynes43/cigar-journal/issues/48)) ([#148](https://github.com/thaynes43/cigar-journal/issues/148)) ([13ef674](https://github.com/thaynes43/cigar-journal/commit/13ef67423e0bd4532b62f6b906051099290f08a6))
* **web:** catalog review console — agent runs, undo, cascade, rename (DESIGN-003 wave 4b) ([#126](https://github.com/thaynes43/cigar-journal/issues/126)) ([#149](https://github.com/thaynes43/cigar-journal/issues/149)) ([b7f3700](https://github.com/thaynes43/cigar-journal/commit/b7f37003f5fe526e54c99e78dcf130a670776c19))
* **web:** markdown fidelity — parse + sanitize original prose ([#128](https://github.com/thaynes43/cigar-journal/issues/128)) ([#146](https://github.com/thaynes43/cigar-journal/issues/146)) ([9002bc3](https://github.com/thaynes43/cigar-journal/commit/9002bc3400cff81f3be882ce6213281f94a3ab9a))


### Bug Fixes

* **oauth:** loopback redirect_uri matching (RFC 8252) + token-endpoint 400 on JSON body ([#144](https://github.com/thaynes43/cigar-journal/issues/144)) ([8ed885d](https://github.com/thaynes43/cigar-journal/commit/8ed885d0260a21286122650de1eb0808ce212486))

## [0.25.1](https://github.com/thaynes43/cigar-journal/compare/v0.25.0...v0.25.1) (2026-08-29)


### Bug Fixes

* **domain:** audit_log.run_id uuid→text — order-key run identities (migration 0016) ([#141](https://github.com/thaynes43/cigar-journal/issues/141)) ([0731f30](https://github.com/thaynes43/cigar-journal/commit/0731f304086ec26f45f9418c9ef22c0052677457))

## [0.25.0](https://github.com/thaynes43/cigar-journal/compare/v0.24.0...v0.25.0) (2026-08-29)


### Features

* **mcp:** curation tool surface — scope, queue reads, curator writes (DESIGN-003 wave 4a) ([#126](https://github.com/thaynes43/cigar-journal/issues/126)) ([#138](https://github.com/thaynes43/cigar-journal/issues/138)) ([0414a24](https://github.com/thaynes43/cigar-journal/commit/0414a2480399030097bd9a2b04e28b14dfa7a52b))
* **web:** catalog filter chips — brand, in stock, smoked, favorites (DESIGN-003 wave 6) ([#136](https://github.com/thaynes43/cigar-journal/issues/136)) ([a045921](https://github.com/thaynes43/cigar-journal/commit/a045921446b8ea2ec4f9e952ddafa5cc942d1f47))
* **web:** curator product-photo upload — direct, upload-link, missing-photos worklist ([#139](https://github.com/thaynes43/cigar-journal/issues/139)) ([2261955](https://github.com/thaynes43/cigar-journal/commit/22619559b1eb834a7a4b1ec2071238986ef3bd88))

## [0.24.0](https://github.com/thaynes43/cigar-journal/compare/v0.23.1...v0.24.0) (2026-08-29)


### Features

* **domain:** curation primitives — rights enforcement, match status, catalog_status, tombstone merge (DESIGN-003 wave 3) ([#131](https://github.com/thaynes43/cigar-journal/issues/131)) ([68589e2](https://github.com/thaynes43/cigar-journal/commit/68589e2b0e68d8d8d239d4767fc721b35e34c533))
* **web:** chrome — user menu, settings, catalog review move (DESIGN-003 wave 2) ([#125](https://github.com/thaynes43/cigar-journal/issues/125)) ([#133](https://github.com/thaynes43/cigar-journal/issues/133)) ([91f95ca](https://github.com/thaynes43/cigar-journal/commit/91f95ca52cd0ae1e474471be91b394d59847b45f))
* **web:** library catalog frame — full-bleed unified grid, shelves, rails (DESIGN-003 wave 1) ([#124](https://github.com/thaynes43/cigar-journal/issues/124)) ([#130](https://github.com/thaynes43/cigar-journal/issues/130)) ([37f3fb4](https://github.com/thaynes43/cigar-journal/commit/37f3fb418becde4138c5c168d792e48b5c7a43bf))


### Bug Fixes

* **mcp:** add_cigar escape hatch + strong-link guard for packaging/one-sided-number variants ([#134](https://github.com/thaynes43/cigar-journal/issues/134)) ([0ad744b](https://github.com/thaynes43/cigar-journal/commit/0ad744b20f378d24b47297bd6a9b7eadd8f115df))

## [0.23.1](https://github.com/thaynes43/cigar-journal/compare/v0.23.0...v0.23.1) (2026-08-29)


### Bug Fixes

* **web:** DESIGN-002 go-live sweep — tile badges, price heading, per-user dates, wait states ([#120](https://github.com/thaynes43/cigar-journal/issues/120)) ([c77882e](https://github.com/thaynes43/cigar-journal/commit/c77882e9fa72271a22a4c4ebdb5186fa27c3db1c))

## [0.23.0](https://github.com/thaynes43/cigar-journal/compare/v0.22.0...v0.23.0) (2026-08-29)


### Features

* **web:** public journal pages — anonymous read for public journals ([#96](https://github.com/thaynes43/cigar-journal/issues/96)) ([#118](https://github.com/thaynes43/cigar-journal/issues/118)) ([88822b1](https://github.com/thaynes43/cigar-journal/commit/88822b13b63ff3ad890e4e315e11642a6cca9bd0))

## [0.22.0](https://github.com/thaynes43/cigar-journal/compare/v0.21.0...v0.22.0) (2026-08-29)


### Features

* **mcp:** browse_catalog + get_offers tools; consolidate instructions & contract ([#94](https://github.com/thaynes43/cigar-journal/issues/94)) ([#117](https://github.com/thaynes43/cigar-journal/issues/117)) ([2637032](https://github.com/thaynes43/cigar-journal/commit/2637032a2262f1a59949cecf7019db43b268b125))
* **web:** complete cigar detail rebuild ([#92](https://github.com/thaynes43/cigar-journal/issues/92)) ([#115](https://github.com/thaynes43/cigar-journal/issues/115)) ([6b0fba6](https://github.com/thaynes43/cigar-journal/commit/6b0fba66d47c7abbfbf7f941ee6cc45467bad07a))

## [0.21.0](https://github.com/thaynes43/cigar-journal/compare/v0.20.0...v0.21.0) (2026-08-29)


### Features

* catalog repair + price observations ([#101](https://github.com/thaynes43/cigar-journal/issues/101), ADR-009) ([#113](https://github.com/thaynes43/cigar-journal/issues/113)) ([09ecad9](https://github.com/thaynes43/cigar-journal/commit/09ecad96806755be7f10c247e6aee35c45b69892))

## [0.20.0](https://github.com/thaynes43/cigar-journal/compare/v0.19.0...v0.20.0) (2026-08-29)


### Features

* favorites — the second cigar-level mark ([#108](https://github.com/thaynes43/cigar-journal/issues/108)) ([#111](https://github.com/thaynes43/cigar-journal/issues/111)) ([cf61e2b](https://github.com/thaynes43/cigar-journal/commit/cf61e2b78f43eaeb9254aa350423912ba78a3137))

## [0.19.0](https://github.com/thaynes43/cigar-journal/compare/v0.18.0...v0.19.0) (2026-08-29)


### Features

* the unified catalog — one surface, ownership facets, ledger view ([#90](https://github.com/thaynes43/cigar-journal/issues/90)) ([#109](https://github.com/thaynes43/cigar-journal/issues/109)) ([5cff7e0](https://github.com/thaynes43/cigar-journal/commit/5cff7e0bdee366be171b292c0660e5c2e3a72889))

## [0.18.0](https://github.com/thaynes43/cigar-journal/compare/v0.17.0...v0.18.0) (2026-08-29)


### Features

* explicit consumption — a smoke deducts by link ([#88](https://github.com/thaynes43/cigar-journal/issues/88), ADR-008) ([#106](https://github.com/thaynes43/cigar-journal/issues/106)) ([04e3248](https://github.com/thaynes43/cigar-journal/commit/04e3248bc162c02d050d9ee4f4833203a5045bdd))
* want v1 — the independent mark ([#105](https://github.com/thaynes43/cigar-journal/issues/105)) ([f6fc29f](https://github.com/thaynes43/cigar-journal/commit/f6fc29f5b4e5237505a6cec11b37ea451608a674))


### Bug Fixes

* **web:** wait states on photo tiles, exit after upload ([#102](https://github.com/thaynes43/cigar-journal/issues/102)) ([3548075](https://github.com/thaynes43/cigar-journal/commit/3548075ac36840a245a2fff39d1d8bfbf3f2b7c7))

## [0.17.0](https://github.com/thaynes43/cigar-journal/compare/v0.16.0...v0.17.0) (2026-08-28)


### Features

* **web:** market prices on the cigar page ([#86](https://github.com/thaynes43/cigar-journal/issues/86)) ([c74b026](https://github.com/thaynes43/cigar-journal/commit/c74b0268cd6c0fc44fb3db4ac11913a4436592ec))

## [0.16.0](https://github.com/thaynes43/cigar-journal/compare/v0.15.0...v0.16.0) (2026-08-28)


### Features

* **web:** brand and line tiles borrow a representative product photo ([#84](https://github.com/thaynes43/cigar-journal/issues/84)) ([b848a8c](https://github.com/thaynes43/cigar-journal/commit/b848a8ced16200d2578806e6b34a0a2116eba1f9))

## [0.15.0](https://github.com/thaynes43/cigar-journal/compare/v0.14.0...v0.15.0) (2026-08-28)


### Features

* **curation:** number-token guard + "not duplicates" dismissal for the queue ([#82](https://github.com/thaynes43/cigar-journal/issues/82)) ([b334e16](https://github.com/thaynes43/cigar-journal/commit/b334e16fbc5fbb3f66a9df8f4a85a04a990caabb))

## [0.14.0](https://github.com/thaynes43/cigar-journal/compare/v0.13.1...v0.14.0) (2026-08-28)


### Features

* add_smoke_photo — dual-mode MCP photo intake ([#44](https://github.com/thaynes43/cigar-journal/issues/44)) ([#80](https://github.com/thaynes43/cigar-journal/issues/80)) ([99a814f](https://github.com/thaynes43/cigar-journal/commit/99a814ff15b35bd2870ca7971cd1dbabe3795092))
* curation queue — merge duplicates, verify cigars ([#45](https://github.com/thaynes43/cigar-journal/issues/45)) ([#78](https://github.com/thaynes43/cigar-journal/issues/78)) ([053b9e8](https://github.com/thaynes43/cigar-journal/commit/053b9e803a64fb85d0c354e74730682aff0a05c3))

## [0.13.1](https://github.com/thaynes43/cigar-journal/compare/v0.13.0...v0.13.1) (2026-08-28)


### Bug Fixes

* **crawler:** decode entities, exclude sets/kits by name before seeding ([#74](https://github.com/thaynes43/cigar-journal/issues/74)) ([6c85fbf](https://github.com/thaynes43/cigar-journal/commit/6c85fbff28467fb9025b546926a1c44b9f48c956))
* **web:** burn line — name it, stagger and cull crowded stage labels ([#76](https://github.com/thaynes43/cigar-journal/issues/76)) ([6bb9e65](https://github.com/thaynes43/cigar-journal/commit/6bb9e650584b0134a811e03af545565087216ffb))

## [0.13.0](https://github.com/thaynes43/cigar-journal/compare/v0.12.0...v0.13.0) (2026-08-28)


### Features

* crawler substrate + Fox Cigar adapter ([#43](https://github.com/thaynes43/cigar-journal/issues/43)) ([#72](https://github.com/thaynes43/cigar-journal/issues/72)) ([6790d65](https://github.com/thaynes43/cigar-journal/commit/6790d6572739999f78d807f77fe4d26fba6caa7b))
* **db:** market substrate schema — product photos, crawl runs, enrichment queue ([#68](https://github.com/thaynes43/cigar-journal/issues/68)) ([57da597](https://github.com/thaynes43/cigar-journal/commit/57da59770a8098694612ef168134f6d35eac0103))
* MCP gap-fill — add_cigar and record_purchase ([#71](https://github.com/thaynes43/cigar-journal/issues/71)) ([fbf031a](https://github.com/thaynes43/cigar-journal/commit/fbf031a2c3e14a0216b2ab00fb76c169d2228b78))


### Bug Fixes

* **web:** favicon — the burn-line stick on the Humidor ground ([#70](https://github.com/thaynes43/cigar-journal/issues/70)) ([9c77a93](https://github.com/thaynes43/cigar-journal/commit/9c77a93945d9a23144ce2a2752b44cdb6086c7e1))

## [0.12.0](https://github.com/thaynes43/cigar-journal/compare/v0.11.0...v0.12.0) (2026-08-28)


### Features

* catalog poster library — brand wall, line sections, still tiles ([#59](https://github.com/thaynes43/cigar-journal/issues/59)) ([#66](https://github.com/thaynes43/cigar-journal/issues/66)) ([2a717ae](https://github.com/thaynes43/cigar-journal/commit/2a717aeecfc0bddb76827f92c1663449da0e8e42))

## [0.11.0](https://github.com/thaynes43/cigar-journal/compare/v0.10.0...v0.11.0) (2026-08-28)


### Features

* inventory MVP — holdings view, /inventory page, get_my_inventory (PRD-002 phase 1) ([#64](https://github.com/thaynes43/cigar-journal/issues/64)) ([397bc36](https://github.com/thaynes43/cigar-journal/commit/397bc36ac809363c59a44e650ff7a7dbe39409fd))


### Bug Fixes

* one-tap photo upload on the smoke page ([#63](https://github.com/thaynes43/cigar-journal/issues/63)) ([658feb6](https://github.com/thaynes43/cigar-journal/commit/658feb6ab4a337ccaa2d544a319f98e17fc7d294))

## [0.10.0](https://github.com/thaynes43/cigar-journal/compare/v0.9.0...v0.10.0) (2026-08-28)


### Features

* smoke-photo substrate — storage, pipeline, upload, display (ADR-007) ([#60](https://github.com/thaynes43/cigar-journal/issues/60)) ([d0aa90b](https://github.com/thaynes43/cigar-journal/commit/d0aa90bd7b8962d75df180cbdb40fe57c6d15aa7))

## [0.9.0](https://github.com/thaynes43/cigar-journal/compare/v0.8.0...v0.9.0) (2026-08-28)


### Features

* **web:** labeled strength meter on journal cards ([#55](https://github.com/thaynes43/cigar-journal/issues/55)) ([7b4bf92](https://github.com/thaynes43/cigar-journal/commit/7b4bf92c1b2a052e5760d31c58cd196629b2e99c))

## [0.8.0](https://github.com/thaynes43/cigar-journal/compare/v0.7.0...v0.8.0) (2026-08-28)


### Features

* MCP hardening from the codex adversarial iteration ([#52](https://github.com/thaynes43/cigar-journal/issues/52)) ([73c2c5a](https://github.com/thaynes43/cigar-journal/commit/73c2c5a20e778269255b52916d1974c7d5351eb6))

## [0.7.0](https://github.com/thaynes43/cigar-journal/compare/v0.6.0...v0.7.0) (2026-08-27)


### Features

* **web:** catalog browse, journal sparkline, smoke-title nit, doc fix ([#40](https://github.com/thaynes43/cigar-journal/issues/40)) ([2c2dedb](https://github.com/thaynes43/cigar-journal/commit/2c2dedbb1eb8d4d8110b4e3c87dd6691745cc88b))

## [0.6.0](https://github.com/thaynes43/cigar-journal/compare/v0.5.0...v0.6.0) (2026-08-27)


### Features

* **mcp:** match provenance on text search + title-is-metadata visibility + docs truth-up ([#37](https://github.com/thaynes43/cigar-journal/issues/37)) ([6910f8f](https://github.com/thaynes43/cigar-journal/commit/6910f8f974dab9fd53af130925dce51b461dc4de))

## [0.5.0](https://github.com/thaynes43/cigar-journal/compare/v0.4.2...v0.5.0) (2026-08-27)


### Features

* **archive:** ledger Purchases snapshot (2026-08-27) + R13 seed note ([#31](https://github.com/thaynes43/cigar-journal/issues/31)) ([02ea5a0](https://github.com/thaynes43/cigar-journal/commit/02ea5a00a574ee8d4cec103767591533d878a345))
* **importer:** ledger reconciliation subcommand ([#34](https://github.com/thaynes43/cigar-journal/issues/34)) ([3940512](https://github.com/thaynes43/cigar-journal/commit/3940512e838746daa7e2f58f47b978b9f1120b10))
* MCP field-test fixes — search coverage, match guard, guidance ([#35](https://github.com/thaynes43/cigar-journal/issues/35)) ([f02470b](https://github.com/thaynes43/cigar-journal/commit/f02470ba3362eac304e9dffa098171841b7010ad))

## [0.4.2](https://github.com/thaynes43/cigar-journal/compare/v0.4.1...v0.4.2) (2026-08-27)


### Bug Fixes

* **oauth:** consent Approve registered as deny — bind the decision ([#29](https://github.com/thaynes43/cigar-journal/issues/29)) ([0c48953](https://github.com/thaynes43/cigar-journal/commit/0c48953b02e0e342d626022ba27450229ec3176e))

## [0.4.1](https://github.com/thaynes43/cigar-journal/compare/v0.4.0...v0.4.1) (2026-08-27)


### Bug Fixes

* **web:** root-path OAuth aliases for stale client caches ([#25](https://github.com/thaynes43/cigar-journal/issues/25)) ([52583e6](https://github.com/thaynes43/cigar-journal/commit/52583e6547ca8f9885b57daa0ccac292b1a8523d))

## [0.4.0](https://github.com/thaynes43/cigar-journal/compare/v0.3.0...v0.4.0) (2026-08-27)


### Features

* MCP adapter — the six-tool journal surface (@cj/mcp) ([#24](https://github.com/thaynes43/cigar-journal/issues/24)) ([c5e2bcd](https://github.com/thaynes43/cigar-journal/commit/c5e2bcd195ce2d80b7b70036f37f5cb5a24e3664))


### Bug Fixes

* **image:** ship workspace-dep sources in the import role ([#20](https://github.com/thaynes43/cigar-journal/issues/20)) ([b8d1965](https://github.com/thaynes43/cigar-journal/commit/b8d19652beea97fb9a29e7f6fceb3b377add14cf))

## [0.3.0](https://github.com/thaynes43/cigar-journal/compare/v0.2.0...v0.3.0) (2026-08-27)


### Features

* legacy archive importer (@cj/importer) ([#19](https://github.com/thaynes43/cigar-journal/issues/19)) ([763985b](https://github.com/thaynes43/cigar-journal/commit/763985b32013d02a12dc2cf28d71f874533c5284))
* OAuth 2.1 authorization server (@cj/oauth) ([#18](https://github.com/thaynes43/cigar-journal/issues/18)) ([111b2d4](https://github.com/thaynes43/cigar-journal/commit/111b2d47840f6ebf7805f94dfd22e085c433e294))


### Bug Fixes

* **web:** record-form usability from first live use ([#16](https://github.com/thaynes43/cigar-journal/issues/16)) ([5779baf](https://github.com/thaynes43/cigar-journal/commit/5779baf77669409d0b21be6410249b7f6789623f))

## [0.2.0](https://github.com/thaynes43/cigar-journal/compare/v0.1.0...v0.2.0) (2026-08-27)


### Features

* multi-role production image and signed publishing ([#13](https://github.com/thaynes43/cigar-journal/issues/13)) ([403d78b](https://github.com/thaynes43/cigar-journal/commit/403d78be2da138fd769eed4f6e7ace071e13aafb))
* Phase 0 MCP compatibility spike server ([#4](https://github.com/thaynes43/cigar-journal/issues/4)) ([077115f](https://github.com/thaynes43/cigar-journal/commit/077115f2757ff1b09b2da7f173172df72da07f54))
* Phase 1 local auth — Better Auth on the app's users table ([#11](https://github.com/thaynes43/cigar-journal/issues/11)) ([22e9576](https://github.com/thaynes43/cigar-journal/commit/22e95769c321aff9623eaec013cbb062bedc7a08))
* Phase 1 monorepo scaffold ([#9](https://github.com/thaynes43/cigar-journal/issues/9)) ([8a5815b](https://github.com/thaynes43/cigar-journal/commit/8a5815bdd60a3a7b8e64c897fd096e48734ffa2d))
* Phase 1 schema and domain model ([#10](https://github.com/thaynes43/cigar-journal/issues/10)) ([f00d9fb](https://github.com/thaynes43/cigar-journal/commit/f00d9fbabb3e23b1bd723331da9350a2f5a79c4e))
* Phase 1 web CRUD — tRPC API and journal pages ([#12](https://github.com/thaynes43/cigar-journal/issues/12)) ([8fff235](https://github.com/thaynes43/cigar-journal/commit/8fff2352c79ac405379ec353abf572065ac17f77))
