# Socials Organizer

A personal tool for organizing saved Instagram posts into collections, with personal notes on both the individual posts and the collections that group them.

## Language

**Post**:
A saved Instagram post or reel — a single piece of Instagram content the user has chosen to keep track of, identified by its Instagram link. The link is set once at creation and never edited afterward.
_Avoid_: Item, card, clip

**Title**:
A short, user-facing label for a Post, shown on its card. Defaults to Description's first sentence and keeps auto-following it as Description changes, until the user hand-edits Title — after which it stops auto-deriving and keeps exactly what they typed.
_Avoid_: Name, headline

**Description**:
A Post's caption text, mirrored from Instagram's own caption at save/import time and freely editable afterward. Distinct from Post Note, which is the user's own private commentary, not the post's caption.
_Avoid_: Caption, note (ambiguous — use Post Note or Collection Note)

**Collection**:
A first-class, user-named group of Posts. Has a name, a Collection Note, and a user-set color.
_Avoid_: Category, group, folder

**Post Note**:
Freeform personal text on a single Post — why it was saved, or anything else worth remembering about it. Distinct from Description, which mirrors the post's own Instagram caption rather than the user's commentary on it.
_Avoid_: Note (ambiguous — use Post Note or Collection Note), annotation

**Collection Note**:
Freeform personal text on a Collection as a whole — what the collection is for, or observations about the set of Posts in it. Distinct from a Post Note, which is about one Post.
_Avoid_: Note (ambiguous — use Post Note or Collection Note), description

**To sort**:
A Post that has not yet been assigned to a Collection.
_Avoid_: Unsorted, untriaged, uncategorized

**Source**:
Which external service a Post was saved from. v1 only supports Instagram, but the concept exists to leave room for other platforms later.
_Avoid_: Platform, origin

**Tag**:
A reusable, user-defined label (a name plus a color drawn from the same preset palette Collections use) that can be attached to any number of Posts; a Post can carry up to 4. Independent of Collection membership — a Post has at most one Collection but any number of Tags.
_Avoid_: Category, label
