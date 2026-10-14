---
name: dsh-ci-test-reliability
description: DSHプラグインの並行テスト、共有状態、clock、subprocess、network listener、非同期解除に関わる不安定さを調査・修正する。
license: MIT
---

# 並行実行でも成り立つテスト

file、worker、process、jobが何を共有するか調べます。同じtest file内を順次実行しても、別processの共有portやpathは保護されません。

## 資源と状態

- network fixtureはloopbackでport `0` にbindし、listen完了後のaddressを使います。空きportの事前探索は予約になりません。
- fileを作成・変更するtestは、`mkdtemp` 等で専用のrootを作り、存在しない必要があるfileはexclusiveに作成します。
- environment、cwd、module cache、fake timer、global handlerの共有を列挙します。可能ならinstance-localやdependency injectionへ移し、変更したものはfinallyで戻します。
- date、mtime、rename、signal、process終了をOSが所有する動作として扱います。単一OSでの精度やタイミングを全OSへ仮定しません。
- 固定path/URLが単なるparser入力なら、資源を取得するfixtureと同じ理由で書き換えません。

## 同期と解除

sleepで順序を期待する代わりに、ready・登録・callback・保存完了等の状態を待ちます。timeoutはCIの負荷と処理段階に合わせますが、timeout増加だけで原因を隠しません。

spawnはerror/exit/closeとstdioの寿命を扱います。killの要求を送っただけで終了確認済みとしません。listener、observer、timer、in-flight要求をfixtureの終わりで解除・drainし、次のtestへ残さないようにします。

## 失敗の再現

認証完了とlogout、save中の再編集、update中の切断、同期throw後のqueue、同時要求、再起動後のreceiptを、変更した処理に合わせて制御します。旧処理が失敗する理由と、修正がその順序を扱う理由を確認します。

rerun成功を原因特定とせず、seed・並行数・環境・残った資源を記録します。suite全体の直列化、失敗の握り潰し、assertion削除より、共有資源の範囲を直します。
