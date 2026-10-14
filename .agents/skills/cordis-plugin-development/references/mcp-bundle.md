# MCP接続のbundle

接続設定だけを追加する場合は、対象DSHにあるMCP clientをpatchから設定するbundleにします。別のMCP runtimeや不要なHost/Client entryを増やさず、packageの表示metadataと配布fileを確認します。

基準版では `@deepseek-ai/dsh-mcp-client` に `serverName`、`transport` と接続設定を渡します。HTTPとstdioで必要なfieldを、対象版のConfigから確認します。stdioのcommand・args・cwd・envは、DSH Hostの環境で解決される値です。

接続URLや環境変数にsecretを埋めてREADME・会話・ログへ載せません。既存credential参照が使える場合はそれを使います。接続先を変更する際は、認証・権限・外部へ渡る情報も確認します。

導入後は実際のagent scopeでtoolを発見し、対象の操作を呼びます。tool名はserverと公開toolから確認し、例のping名を架空の成功確認に使いません。起動失敗・接続切断・OFF時の子process/通信解除を確認します。

根拠: [公式MCP参照](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/preset/agent-preset/skills/cordis-plugin-development/references/mcp-bundle.md)。
