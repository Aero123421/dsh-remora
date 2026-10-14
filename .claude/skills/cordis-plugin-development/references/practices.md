# 拡張点と共存

service、provider、event、tool、slotの最も小さい拡張で目的を満たします。保存状態とmodel-visible情報の所有者を確認し、plugin内cacheを永続記録の代わりにしません。

基準版向けの独立pluginでは、対象DSHが知らないtypeを `Session.append()` へ追加しません。モデルへ渡す内容は既存のmessage・tool結果や確認済みのagent APIを使い、plugin固有の保存状態は利用できるstorage APIへ置きます。`appendPluginRecord()` は本体の実験package用で、外部plugin向けの保存入口ではありません。本体のeventや保存形式を変える依頼では、その変更に必要なreader互換性とmigrationを確認します。

根拠: [外部pluginの利用制約](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/session/README.md#L70)、[appendの実装](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/session/src/index.ts#L798)、[未知eventの復元時検査](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/session/session-format-v3-to-v4/src/validation.ts#L58)。

## scopeと権限

global登録の成功は、agentのtool一覧へ出ることの証明ではありません。同名のscoped toolやrestrict、親子Sessionの選択を含めて、実際のschemaとdispatchを確認します。

ツールを減らすrestrict、拒否を追加するguard、引数や結果を書き換えるwaterfall、prompt全体のassemblyは影響が異なります。利用者が求めた動作を満たす範囲を選び、他pluginの拒否を緩めません。waterfallを委譲するときは `next()` を呼び、decisionの関係ないfieldを維持します。

UIやログイン追加を理由に、persona、context gate、token saver、agent loopの変更まで同時に入れません。モデル動作を変える機能はその目的と確認を分けます。

## 所有と非同期処理

process handle、route、CSS、設定namespace、credential key、callback、timerの所有を列挙します。pluginのOFF、接続の再生成、Session終了、service停止は別の寿命です。

古い接続・認証試行・編集の完了を、現在の状態へ反映しません。generation、request ID、candidate ID等は、識別すべき操作に合わせます。値が同じという比較だけで別の編集を同一視しません。

共有DOM/CSS変数の復元は、自分が設定した値をまだ所有する場合に限ります。共有設定は所有serviceの原子的更新やrevision付き更新を使い、現在値の対象fieldだけを変更します。自分で排他を持つ場合は、最新値の読取りから保存までをその内側へ置きます。別pluginの登録やクラウド資源を名前の一致だけで削除しません。

## 併用確認

共有する資源がある組合せを選び、A→BとB→A、片方のOFF/ON・reloadを確認します。proxyはHost/Origin等の管理元判定を変えないこと、PWAは他worker/cacheを一括削除しないことも、対象機能に応じて確認します。

基準となる実例は[共存の調査](https://github.com/Aero123421/dsh-plginreview/blob/main/docs/plugin-coexistence.md)、設計の比較は[横断分析](https://github.com/Aero123421/dsh-plginreview/blob/main/docs/ecosystem/deep-patterns.md)にあります。全組合せの試験を毎回要求せず、今回共有・変更した境界から選びます。
