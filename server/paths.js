/**
 * Where the database file and the uploaded images live.
 *
 * One module, because a persistent disk on a host is a single mount and both
 * have to sit inside it. Mounting only data/ would keep every row and lose
 * every photograph — a worklist of broken images, which is worse than a clean
 * reset, because it looks like a bug rather than a documented trade-off.
 *
 *   VAR_DIR=/var/data           both, under one mount   (Render disk)
 *   VAR_DIR=D:/retinax-data     both, on your own drive (local, permanent)
 *   unset                       ./data and ./uploads    (the default)
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

export const VAR_DIR = process.env.VAR_DIR || ".";
export const DATA_DIR = process.env.DATA_DIR || path.join(VAR_DIR, "data");
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(VAR_DIR, "uploads");

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(UPLOAD_DIR, { recursive: true });
