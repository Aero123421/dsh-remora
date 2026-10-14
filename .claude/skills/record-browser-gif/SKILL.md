---
name: record-browser-gif
description: DSHプラグインのUI操作を、依頼や検証目的に合わせて録画し、条件を記録した短いGIFにする。公開は依頼範囲に従う。
license: MIT
---

# UI操作のGIF

録画する操作と、説明したい結果を決めます。GIFは全UI変更の必須条件にせず、依頼された場合や、操作の説明・確認に役立つ場合に使います。

## 録画する

対象commitの実DSH画面を、利用できるbrowser-controlまたはPlaywright等で開きます。fixtureやmockを使う場合は、その条件を明記します。実model/APIの使用は、その検証が依頼・許可された範囲で行います。

ログイン・token・認証URL・実ユーザーの会話が映らない確認環境を使います。viewport、locale、theme、profile、plugin版、操作を記録し、同じ条件で見直せるようにします。

必要な操作と結果だけを含め、videoまたは連続frameをローカルへ保存します。最後の状態を読む時間を残し、問題が起きたframeを隠して成功したように編集しません。

## GIFへ変換する

利用できるencoderでframe rate・寸法・paletteを調整します。ffmpegを使う場合は [変換例](references/encoding.md) を参照します。再生して文字、操作順、長さ、fileサイズを確認します。

## 公開する

ローカル録画と、PR添付・uploadを分けます。公開が依頼範囲に含まれる場合は、利用可能な添付機能で意図したfileだけを公開します。GIFのために無関係なassets branchを自動作成しません。

公開時は対象commit、表示を配信した環境、fixture/mock/実APIの条件、示した操作を添えます。GIFは録画した経路の証拠であり、全OSや他のpluginとの併用を証明するものではありません。
