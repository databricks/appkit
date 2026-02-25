# Changelog

All notable changes to this project will be documented in this file.

## [0.10.1](https://github.com/databricks/appkit/compare/v0.10.0...v0.10.1) (2026-02-25)

* generate types command ([#137](https://github.com/databricks/appkit/issues/137)) ([af8ebbf](https://github.com/databricks/appkit/commit/af8ebbf4d729483797c61addf041961f6ccf6586))

## [0.10.0](https://github.com/databricks/appkit/compare/v0.9.0...v0.10.0) (2026-02-25)

### lakebase

* **lakebase:** add ability to lookup DB username with API ([#123](https://github.com/databricks/appkit/issues/123)) ([1af3f64](https://github.com/databricks/appkit/commit/1af3f6479eb5d71e4bbbd57cbd070d9e88ce23aa))

## [0.9.0](https://github.com/databricks/appkit/compare/v0.8.0...v0.9.0) (2026-02-24)

* add plugin commands ([#110](https://github.com/databricks/appkit/issues/110)) ([ec5481d](https://github.com/databricks/appkit/commit/ec5481dea46c5a6f2d85e5942e31fa0582caefbe))

## [0.8.0](https://github.com/databricks/appkit/compare/v0.7.4...v0.8.0) (2026-02-23)

* allow overriding vite client port ([#124](https://github.com/databricks/appkit/issues/124)) ([6142ec9](https://github.com/databricks/appkit/commit/6142ec956b996b6edb7e71379328ec42be4a2aa9))

## [0.7.4](https://github.com/databricks/appkit/compare/v0.7.3...v0.7.4) (2026-02-18)

* typegen command ([#119](https://github.com/databricks/appkit/issues/119)) ([8c3735c](https://github.com/databricks/appkit/commit/8c3735c6b27c5e5cbacb81363ccaf4f6acbfd185))

## [0.7.3](https://github.com/databricks/appkit/compare/v0.7.2...v0.7.3) (2026-02-18)

* release `@databricks/lakebase` correctly, fix `appkit` dependency ([#111](https://github.com/databricks/appkit/issues/111)) ([5b6856a](https://github.com/databricks/appkit/commit/5b6856a6b42680a671cfc3e99eab3bef72803fd1))

## [0.7.2](https://github.com/databricks/appkit/compare/v0.7.1...v0.7.2) (2026-02-18)

* template sync ([#109](https://github.com/databricks/appkit/issues/109)) ([f250016](https://github.com/databricks/appkit/commit/f250016b28e24e3ce56d09a0a3d95088a689a943))

## [0.7.1](https://github.com/databricks/appkit/compare/v0.7.0...v0.7.1) (2026-02-18)

* sync template versions on release ([#105](https://github.com/databricks/appkit/issues/105)) ([4cbe826](https://github.com/databricks/appkit/commit/4cbe8266e80e4b4cfe4b4e0594c2633dcba7123a))

## [0.7.0](https://github.com/databricks/appkit/compare/v0.6.0...v0.7.0) (2026-02-17)

* introduce Lakebase Autoscaling driver ([#98](https://github.com/databricks/appkit/issues/98)) ([27b1848](https://github.com/databricks/appkit/commit/27b184886b2ab15c73f3d46f5ff9e9c6d8806c71))

## [0.6.0](https://github.com/databricks/appkit/compare/v0.5.4...v0.6.0) (2026-02-16)

### appkit

* **appkit:** plugin manifest definition ([#82](https://github.com/databricks/appkit/issues/82)) ([b40f5ca](https://github.com/databricks/appkit/commit/b40f5ca2e7a9214939c2d9bd9cea6be6bb993d53))

## [0.5.4](https://github.com/databricks/appkit/compare/v0.5.3...v0.5.4) (2026-02-12)

* surface SQL error messages in typegen DESCRIBE failures ([#94](https://github.com/databricks/appkit/issues/94)) ([75d94e7](https://github.com/databricks/appkit/commit/75d94e799ba0db79bf6e8c603b0346822ddb4560))

## [0.5.3](https://github.com/databricks/appkit/compare/v0.5.2...v0.5.3) (2026-02-10)

* run typegen automatically via npm lifecycle hooks ([#92](https://github.com/databricks/appkit/issues/92)) ([80b7a96](https://github.com/databricks/appkit/commit/80b7a96b330bbe8949a0ce981d22680458b930bf))

## [0.5.2](https://github.com/databricks/appkit/compare/v0.5.1...v0.5.2) (2026-02-04)

* skip type generation when queries directory is missing ([#84](https://github.com/databricks/appkit/issues/84)) ([76b3aa0](https://github.com/databricks/appkit/commit/76b3aa00d2ad4985330c60b4849a3ba4303c9591))

## [0.5.1](https://github.com/databricks/appkit/compare/v0.5.0...v0.5.1) (2026-02-02)

* query reads on dev-remote ([#72](https://github.com/databricks/appkit/issues/72)) ([34bb1dc](https://github.com/databricks/appkit/commit/34bb1dc6fa6a220ecb624b408701c3f73dddeac4))

## [0.5.0](https://github.com/databricks/appkit/compare/v0.4.1...v0.5.0) (2026-01-30)

* appkit exposed apis ([#69](https://github.com/databricks/appkit/issues/69)) ([822d98e](https://github.com/databricks/appkit/commit/822d98e2f607c33fd7aa72166aca86c6d0fdaea3))

## [0.4.1](https://github.com/databricks/appkit/compare/v0.4.0...v0.4.1) (2026-01-30)

* Revert "chore: bump packages in the template (#70)" (#71) ([268c8cf](https://github.com/databricks/appkit/commit/268c8cf52a243abc9f17f96425cfbdf01809e471)), closes [#70](https://github.com/databricks/appkit/issues/70) [#71](https://github.com/databricks/appkit/issues/71)

## [0.4.0](https://github.com/databricks/appkit/compare/v0.3.0...v0.4.0) (2026-01-29)

* embed `appkit` CLI and AI-targeted docs into the `appkit` and `appkit-ui` packages ([#64](https://github.com/databricks/appkit/issues/64)) ([58794e8](https://github.com/databricks/appkit/commit/58794e80a3b56e02d806507e4fbfd5519bc7aa02))

## [0.3.0](https://github.com/databricks/appkit/compare/v0.2.0...v0.3.0) (2026-01-22)

* add .obo conventions on sql files ([#61](https://github.com/databricks/appkit/issues/61)) ([00a74c1](https://github.com/databricks/appkit/commit/00a74c136ded16b17ae756e0f99f7d0efa3e9fda))

## [0.2.0](https://github.com/databricks/appkit/compare/v0.1.5...v0.2.0) (2026-01-22)

### observability

* **observability:** add structured logging ([#51](https://github.com/databricks/appkit/issues/51)) ([a827c5d](https://github.com/databricks/appkit/commit/a827c5d03b116e4905ba142d672724205f8c094e))

## [0.1.5](https://github.com/databricks/appkit/compare/v0.1.4...v0.1.5) (2026-01-08)

### appkit

* **appkit:** obo logic and api usage ([#39](https://github.com/databricks/appkit/issues/39)) ([4976b1a](https://github.com/databricks/appkit/commit/4976b1a7160749b55723894bc1d49e8ea8614598))

## [0.1.4](https://github.com/databricks/appkit/compare/v0.1.3...v0.1.4) (2025-12-26)

### appkit

* **appkit:** update llms.txt file ([#38](https://github.com/databricks/appkit/issues/38)) ([1548028](https://github.com/databricks/appkit/commit/1548028261722d9e3d0e867959367865ea840d85))

## [0.1.3](https://github.com/databricks/appkit/compare/v0.1.2...v0.1.3) (2025-12-26)

### appkit

* **appkit:** query cache generation ([#37](https://github.com/databricks/appkit/issues/37)) ([db5e266](https://github.com/databricks/appkit/commit/db5e26608a1751e795e2edb5f1c401040db089e7))

## [0.1.2](https://github.com/databricks/appkit/compare/v0.1.1...v0.1.2) (2025-12-23)

### appkit

* **appkit:** generate types ([#35](https://github.com/databricks/appkit/issues/35)) ([258b768](https://github.com/databricks/appkit/commit/258b76848b1c0aac61bf244a7a95774fb8a47479))

## [0.1.1](https://github.com/databricks/appkit/compare/v0.1.0...v0.1.1) (2025-12-23)

* one-time publish workflow ([#36](https://github.com/databricks/appkit/issues/36)) ([428053b](https://github.com/databricks/appkit/commit/428053b5b122a5e54626196d1f4d8b3de17c9370))

## [0.1.0](https://github.com/databricks/appkit/compare/v0.0.2...v0.1.0) (2025-12-23)

* automatic release ([#31](https://github.com/databricks/appkit/issues/31)) ([7867d54](https://github.com/databricks/appkit/commit/7867d547d63417e389fed5b6c2928cf63c027a7a))
* notice.md ([#30](https://github.com/databricks/appkit/issues/30)) ([6d02543](https://github.com/databricks/appkit/commit/6d02543100ef3a5fce4812eabb8c578731cfc41c))
* type-safety demo theme ([#14](https://github.com/databricks/appkit/issues/14)) ([eab85a5](https://github.com/databricks/appkit/commit/eab85a5cd1415bbd0eaca626f51bca6662372ece))
* setup basic CI pipeline for docs ([#24](https://github.com/databricks/appkit/issues/24)) ([09c73e2](https://github.com/databricks/appkit/commit/09c73e200631dfbe8b139f287755839a84fb9373))
* customize website ([#25](https://github.com/databricks/appkit/issues/25)) ([7fc05c9](https://github.com/databricks/appkit/commit/7fc05c933f79ca0126508f38bbd80ecfc188b2a6))
* new llms.txt ([#34](https://github.com/databricks/appkit/issues/34)) ([19102be](https://github.com/databricks/appkit/commit/19102be47a417b87b30b5df24774a35e00e72d5d))
* setup a Docusaurs website ([#23](https://github.com/databricks/appkit/issues/23)) ([e6b6b54](https://github.com/databricks/appkit/commit/e6b6b545a1532a7ce87475c4c3b28b8801009efb))
* add type-safe sql queries with query registry ([#11](https://github.com/databricks/appkit/issues/11)) ([58f73ad](https://github.com/databricks/appkit/commit/58f73ad6b9399a220cd260a288fc6e8f9d3ff9ba))
* appkit setup ([#22](https://github.com/databricks/appkit/issues/22)) ([68ff9e1](https://github.com/databricks/appkit/commit/68ff9e1c8324b0aa22c547a79db97d592bb69af7))
* arrow stream integration ([#16](https://github.com/databricks/appkit/issues/16)) ([3128ce3](https://github.com/databricks/appkit/commit/3128ce3e5af771394c99e283b68879e2cce60c01))
* configure Databricks client user agent ([#12](https://github.com/databricks/appkit/issues/12)) ([5560cba](https://github.com/databricks/appkit/commit/5560cbacc54d53a9f19adc0f526c500aeaa80536))
* inject config from server ([#27](https://github.com/databricks/appkit/issues/27)) ([2e792d2](https://github.com/databricks/appkit/commit/2e792d28924418222f13f6aedcb004ca238770eb))
* reexport shadcn components and theme ([#2](https://github.com/databricks/appkit/issues/2)) ([4964c07](https://github.com/databricks/appkit/commit/4964c076a4c4507b2d501fd2f1febe806192ab0a))
