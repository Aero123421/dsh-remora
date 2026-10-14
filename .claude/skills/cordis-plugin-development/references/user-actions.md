# 操作と呼出し元

UI、CLI、agent toolから同じ機能を呼ぶ場合は、Hostの処理と結果型を共有します。callerごとに資格情報の保存や資源の作成を別実装へ分けません。

UI操作をすべてagent toolにする必要はありません。表示の展開・tab切替、認証コードの入力、権限を付与する操作、管理者の更新は、必要なcallerと許可を選びます。agentが自分の承認を確定する入口は作りません。

登録・認証状態の表示、設定保存、provider選択、外部送信、コード導入では、権限と副作用が異なります。コード導入・profile管理などの管理操作は、対象とcallerの権限をHostで検査します。URLやcommandを入力として扱う機能は、その機能で許可する範囲と入力の契約に従って検証します。

共有操作は各callerの入力、返却結果、失敗、取消、状態変化を照合します。UI側だけのdisableをHost側の拒否と取り違えません。user-only操作はagentが実行・承認できず、利用者の権限を持たないcallerから通らないことを確認します。利用者のUIも [Remote経由で操作する](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-approval/src/client/index.ts#L104) ため、user-onlyをRemote全体の禁止として扱いません。local限定など、各機能の許可条件は保ちます。

根拠: [公式の操作設計](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/preset/agent-preset/skills/cordis-plugin-development/references/user-actions.md)。共有処理と、どのcallerへ公開するかを分けて適用します。
