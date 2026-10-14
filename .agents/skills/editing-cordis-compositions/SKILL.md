---
name: editing-cordis-compositions
description: DSHのagent presetやCordis構成を作成・変更・検証し、共有Hostとpreset内の配置を決める。
license: MIT
---

# プリセットと構成の編集

プリセットを変える依頼か、共有Host機能の追加かを確認します。日本語化・ログイン・画面の変更だけで、既存personaやagent動作を変更しません。

## 宣言と配置

基準版のpresetはbundle patch内の `@deepseek-ai/dsh-agent-preset` の宣言です。Configの `id` と `plugins`、必要な `name`・`description`・`order` を確認します。既存presetへのoverrideは `config` 全体を置換します。

Hostは共有service、保存、settings、model route等を持ち、presetはscoped tool・persona・policy等を選びます。preset内のservice providerをisolateする場合はconsumerも同じrealmへ置きます。scopeとservice instanceの分離は別です。

## 編集と導入

1. 対象版のプリセット宣言と、既存profileのlayerを読みます。独立したworkspace bundleに変更を書きます。
2. row ID、依存package、Config、参照資源を検査します。旧 `.agent-presets` ディレクトリを読むかどうかは対象版で確認します。
3. 環境で使えるmanagerまたはCLIで導入し、保存結果、activation、rosterの診断を読みます。
4. 新しいSessionで選択・tool一覧・実行を確認します。既存Sessionと子Sessionが旧revisionを使う場合、その結果を新しい構成の成功としません。

移行時は旧persona・plugin list・設定を読み、対象版の名前とAPIへ合わせます。旧fileの削除は、新構成の確認と利用者が必要な復元先を確保してから扱います。

参照: [公式のpreset手順](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md)。表示だけのプラグインにはpresetを追加しません。
