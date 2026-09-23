# Socials Organizer

A personal, local-first tool to display, organize, annotate, and revisit saved Instagram posts.

## Features

- **Collections**: group saved posts under a named, colored Collection with its own note; posts with no Collection sit in "To sort"
- **Tags**: reusable labels (up to 4 per post), independent of Collection
- **Title, Description, Post Note**: editable title and mirrored caption, plus a private note per post
- **Search, sort, and group by tag** across all posts or within a Collection
- **Import**: pull posts straight from an Instagram "Download your information" export, auto-creating Collections by name and skipping anything already saved
- **Embed preview**: each post shows its official Instagram embed, with an open-in-browser fallback
- **JSON backup/restore**: download a full backup of your data at any time, or restore from one (a full wipe-and-replace)

## Requirements

- Node.js >= 22.5.0
- No dependencies to install — uses only Node's built-ins (`node:http`, `node:sqlite`), no build step

## Running

```
node --run start
```

Then open <http://localhost:3000>. Data is stored locally in `data/socials-organizer.db`, created automatically on first run. Override the port with `PORT=xxxx node --run start`.

## Tests

```
node --run test
```
