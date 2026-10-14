# 配布物と導入

利用者に渡すpackageを決めます。GitHubルートが開発workspaceでbundleがleafにある場合は、ルート指定で導入できるとは案内しません。宣言があるpackageと、その公開entry・patch・資源を追います。

## 導入経路

画面の入力はpackage指定です。CLIコマンド全体を入力させません。次は置換する形式の例で、実行・公開済みのpackageではありません。

```text
github:OWNER/REPO#TAG
PACKAGE@VERSION
https://github.com/OWNER/REPO/releases/download/TAG/PACKAGE-VERSION.tgz
```

CLIは対象版で確認した `dsh plugin --profile PROFILE add SPEC` を使います。pnpm workspace rootへの追加で `ERR_PNPM_ADDING_TO_ROOT` が出る環境では、対象版の `-w` やworkspace設定を調べます。CLIのflagがUIやHost APIへ自動的に引き継がれるとは扱いません。

DSH Webへ渡すローカルpathはHost側のpathです。ブラウザー端末からのアップロードとは区別します。タグなしのGitHub指定は取得時の既定ブランチであり、再現確認には公開tag・commitを使います。

## 公開する中身

Git追跡file、`files`、build出力、packされたfile一覧は別に検査します。Host/Client entry、patch、辞書、CSS、font、icon、licenseを公開物に含めます。GitHub導入でbuildが必要なら、build依存とinstallerの扱いを確認します。実行可能JSで足りるbundleへ不要なbuildを足しません。

peerのDSH対応範囲と、bundlerのexternalを確認します。不一致を検査の無効化で隠しません。integrity/checksum一致、entryの存在、依存解決、Loader登録、実機機能を別に確認します。

installerが依存build scriptの許可待ちを返した場合は、既存の許可範囲を確認します。未許可のscriptを実行するために `approvedBuilds` やprofile設定を自動で補いません。詳しい判定は [Hostの導入](host-plugin.md#導入) にあります。

## 公開するコミット

package・lockfile・実行版・tagをそろえ、テストしたコミットのtarballを公開します。runtime出力とRelease assetの置場を分け、assetは意図したfile名へ限定します。公開済みtagを別コミットへ動かさず、新しい版で修正します。

根拠と事例: [導入手順](https://github.com/Aero123421/dsh-plginreview/blob/main/docs/installation.md)、[配布工程](https://github.com/Aero123421/dsh-plginreview/blob/main/docs/release.md)、[公開tarballの検査](https://github.com/Aero123421/dsh-plginreview/blob/main/docs/ecosystem/deep-package-checks.md)。
