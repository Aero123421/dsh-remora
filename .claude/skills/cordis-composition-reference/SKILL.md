---
name: cordis-composition-reference
description: DSHのbundle patchを読み書きするときに、insert・override・group・disabled・isolateと設定置換の規則を確認する。
license: MIT
---

# Cordis構成の参照

対象DSHのLoaderと、変更するprofileの既存patchを確認します。導入・公開・機能検証の手順は、このSkillへ混ぜません。

## patchの規則

- `insert` はrowを追加します。`id` が既存の `group: true` rowを指す場合は、そのgroupの `config` listへ追加します。
- `insert` がない `id` 指定は既存rowへのoverrideです。`config` は全体を置換するため、必要な既存fieldを残します。
- overrideのtruthyな `name` は既存plugin名の確認です。別のplugin名へ変更する指定と取り違えません。
- 対象rowがないpatchや無効なidへの診断を確認します。保存されたpatchがactivationへ反映されたとは限りません。
- `disabled` によるmountの制御、設定内の `!!js`、`inject` のactivation順序を対象版で確認します。通常の値と式を無条件に相互変換しません。

## scopeとisolate

scopeは登録・event・toolの見える範囲、isolateはservice instanceの分離です。preset内にservice providerを置く場合は、providerと全consumerが同じrealmで解決されることを確認します。Host consumerが使うserviceをpresetだけへ移しません。

必要なpackageは対象版のmanifest、README、型、既存patchから探します。古い一覧にあるpackage名やConfigを、現行環境に存在すると仮定しません。

[Loaderの詳細](references/loader.md)に、確認版の記法と適用確認をまとめています。
