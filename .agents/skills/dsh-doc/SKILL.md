---
name: dsh-doc
description: DSHプラグインのREADME、導入・更新・設定・互換性の文書と開発資料を、公開物と検証の根拠に合わせて作成・修正する。
license: MIT
---

# プラグインの文書

読む人が次に行う操作を先に置きます。READMEは機能、対象DSH、導入、必要な条件を扱い、設定や更新・再起動は該当する場合に含めます。長い実装資料は別の参照先へ置きます。

## 根拠を確認する

bundle、raw plugin、library、preset、別アプリのadapterのどれかをmanifestとentryで判定します。GitHubルートがbundleか、workspace leafやRelease tarballが導入対象かを確認して手順を書きます。

コマンドは対象環境で実行できるときに確認します。例だけの値、ソースから読んだ挙動、作者の検証報告、今回実行した結果を区別します。未実行の外部通信や導入を成功した実績として書きません。資料作成のために利用者のprofileやcloudを変更しません。

公開tag、package版、entry、patch、asset、licenseを照合します。DSH WebのローカルpathはHost側であること、再起動が必要ならHostとブラウザーのどちらかを明記します。

## 構成と表現

簡単な変更に形式的な要約・目次・翻訳pairを増やしません。見出しは読者の操作や調べる対象に合わせ、実装の説明は必要な利用条件と結びます。

失敗、副作用、保存先、設定・資格情報の保持、対象版、未検証の条件を残します。説明の重複、作業履歴の語り、宣伝だけの文言を削ります。日本語を基本に、別言語への翻訳は依頼・既存の公開方針に合わせます。

## 確認

Markdown・リンク・見出し・例・fileの存在を確認し、変更に合う文書検証を選びます。生成資料は所有するsourceから更新します。既存の公開記録を、現在の仕様として無言で差し替えません。

例: [導入](https://github.com/Aero123421/dsh-plginreview/blob/main/docs/installation.md)、[公開](https://github.com/Aero123421/dsh-plginreview/blob/main/docs/release.md)。
