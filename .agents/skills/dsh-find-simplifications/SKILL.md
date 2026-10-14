---
name: dsh-find-simplifications
description: DSHプラグインの不要・重複・未使用のコード、設定、依存、文書を、consumerと互換性を追って削減する。
license: MIT
---

# 実装を簡単にする

依頼範囲、既存の設計理由、公開API・保存形式・拡張点を確認します。コードが長いことや、手元の検索で呼出しが見つからないことだけを削除の根拠にしません。

## 利用経路を追う

export、dynamic import、Loader patch、Client factory、Config、tool、saved data、test、生成物、公開packageを追います。古いデータのreaderや第三者consumerは、source内の直接参照だけで判定できません。

同じ状態の複数保存、独自installer、SDKの重複、共有設定のコピー、過剰なcacheやpolling、使われないConfigを調べます。service境界・profile・権限・解除の差が、重複に見える実装の理由ではないか確認します。

## 小さい変更を選ぶ

削れるコード・設定・依存と、残る責任を説明します。新しい共通frameworkやdependencyが必要なら、保守する量が実際に減るかを比較します。

providerやcacheをまとめる場合も、account/profile/Sessionの分離、失敗・取消・保存の所有を維持します。短いコードにするためにcatchで成功へ変えたり、cleanupを落としたりしません。

提案だけの依頼では、候補・根拠・影響・確認方法を返します。修正が依頼された場合は小さな差分にし、削除前後の関連テストと公開entry・保存互換性を確認します。
