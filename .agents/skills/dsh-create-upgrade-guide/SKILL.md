---
name: dsh-create-upgrade-guide
description: DSHプラグインのCLI、設定、保存データ、API、公開entry等に利用者が見える破壊的変更があるとき、移行と復旧条件を文書化する。
license: MIT
---

# 移行案内

変更前の利用者が、更新後に何を変える必要があるかを書きます。内部だけの変更、利用者操作なしの互換変更、単なるstyle変更へ移行手順を作りません。

## 変更と同時に記録する

package名・entry、CLI、Config key、credential scope、保存schema、event/APIの読取り、最低DSH版の変更を確認します。互換性が失われる条件が分かった時点で、所有する変更へ案内を含めます。

既存のupgrade guide・release notesの置場を使います。形式がなければ、対象版と移行内容を識別できる簡単な文書にします。本体専用のfrontmatterや翻訳pairを要求しません。

## 書く内容

- 影響する旧版・設定・操作と、更新先の版。
- before/afterの設定・command・公開entryと、利用者が必要な操作。
- 自動migrationの範囲、backup、資格情報・ON/OFFの扱い。
- Host再起動などの反映条件と、成功を確認する方法。
- 旧版への復帰が可能な範囲と、読取り不能になる保存変更。

自動migration済みなのに手作業を案内しないようにし、既存credentialを失う名前変更を隠しません。旧Readerが読める根拠がなければdowngrade可能と書きません。

旧状態からの実検証と、案内の例・link・公開版を確認します。まだ実行していないOS・migration・復旧はその範囲を記載します。
