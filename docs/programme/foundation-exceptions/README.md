# Foundation Exceptions

A change to a frozen package (see `../STREAM_OWNERSHIP.md`) needs a record `<id>.md` here with:
problem · why a stream-local solution is insufficient · affected shared packages · proposed change ·
compatibility impact · migration impact · test impact · alternatives considered.

It then ships as a small isolated PR that passes the full Foundation regression, the architecture
gate and an independent review, and is checked for Market, Professional and (where relevant) Admin
compatibility before the supervisor merges it. Major architecture changes go to the owner.
