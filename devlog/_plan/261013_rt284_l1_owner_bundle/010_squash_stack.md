# 010 — wp1 squash stack

Run in `/private/tmp/rt284-lanes/L1`, in this order: #6986, #6994, #6993, #6995, #6997, #6999, #6996, #6959, #6961.

For each PR N:

```sh
git fetch origin pull/N/head:refs/rt284-l1/prN
git merge --squash refs/rt284-l1/prN
git commit -F <msg>   # "<PR title> (#N)" + summary lines + "Closes #<issue>" when the PR closes one
```

The author stays lidge-jun, the same identity as every source PR.

Acceptance: `git log --oneline origin/dev..HEAD` shows nine commits in order. `git diff refs/rt284-l1/prN^..` is not used; instead, the tree equals the trial tree `/private/tmp/ocx-rt284-trial-20627` at its ninth commit (`git diff <trial-9th> HEAD --stat` is empty).

