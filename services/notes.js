const sql = require('./sql');
const options = require('./options');
const utils = require('./utils');
const notes = require('./notes');
const audit_category = require('./audit_category');
const data_encryption = require('./data_encryption');
const sync_table = require('./sync_table');

async function createNewNote(parentNoteId, note, browserId) {
    const noteId = utils.newNoteId();
    const noteTreeId = utils.newNoteTreeId();

    let newNotePos = 0;

    if (note.target === 'into') {
        const maxNotePos = await sql.getSingleValue('SELECT MAX(note_pos) FROM notes_tree WHERE note_pid = ? AND is_deleted = 0', [parentNoteId]);

        newNotePos = maxNotePos === null ? 0 : maxNotePos + 1;
    }
    else if (note.target === 'after') {
        const afterNote = await sql.getSingleResult('SELECT note_pos FROM notes_tree WHERE note_tree_id = ?', [note.target_note_tree_id]);

        newNotePos = afterNote.note_pos + 1;

        await sql.execute('UPDATE notes_tree SET note_pos = note_pos + 1, date_modified = ? WHERE note_pid = ? AND note_pos > ? AND is_deleted = 0',
            [utils.nowTimestamp(), parentNoteId, afterNote.note_pos]);
    }
    else {
        throw new Error('Unknown target: ' + note.target);
    }

    await sql.doInTransaction(async () => {
        await sql.addAudit(audit_category.CREATE_NOTE, browserId, noteId);
        await sync_table.addNoteTreeSync(noteTreeId);
        await sync_table.addNoteSync(noteId);

        const now = utils.nowTimestamp();

        await sql.insert("notes", {
            'note_id': noteId,
            'note_title': note.note_title,
            'note_text': '',
            'date_created': now,
            'date_modified': now,
            'is_protected': note.is_protected
        });

        await sql.insert("notes_tree", {
            'note_tree_id': noteTreeId,
            'note_id': noteId,
            'note_pid': parentNoteId,
            'note_pos': newNotePos,
            'is_expanded': 0,
            'date_modified': now,
            'is_deleted': 0
        });
    });

    return {
        noteId,
        noteTreeId
    };
}

async function encryptNote(note, ctx) {
    note.detail.note_title = data_encryption.encrypt(ctx.getDataKey(), data_encryption.noteTitleIv(note.detail.note_id), note.detail.note_title);
    note.detail.note_text = data_encryption.encrypt(ctx.getDataKey(), data_encryption.noteTextIv(note.detail.note_id), note.detail.note_text);
}

async function protectNoteRecursively(noteId, dataKey, protect) {
    const note = await sql.getSingleResult("SELECT * FROM notes WHERE note_id = ?", [noteId]);

    await protectNote(note, dataKey, protect);

    const children = await sql.getFlattenedResults("note_id", "SELECT note_id FROM notes_tree WHERE note_pid = ?", [noteId]);

    for (const childNoteId of children) {
        await protectNoteRecursively(childNoteId, dataKey, protect);
    }
}

async function protectNote(note, dataKey, protect) {
    let changed = false;

    if (protect && !note.is_protected) {
        note.note_title = data_encryption.encrypt(dataKey, data_encryption.noteTitleIv(note.note_id), note.note_title);
        note.note_text = data_encryption.encrypt(dataKey, data_encryption.noteTextIv(note.note_id), note.note_text);
        note.is_protected = true;

        changed = true;
    }
    else if (!protect && note.is_protected) {
        note.note_title = data_encryption.decryptString(dataKey, data_encryption.noteTitleIv(note.note_id), note.note_title);
        note.note_text = data_encryption.decryptString(dataKey, data_encryption.noteTextIv(note.note_id), note.note_text);
        note.is_protected = false;

        changed = true;
    }

    if (changed) {
        console.log("Updating...");

        await sql.execute("UPDATE notes SET note_title = ?, note_text = ?, is_protected = ? WHERE note_id = ?",
            [note.note_title, note.note_text, note.is_protected, note.note_id]);

        await sync_table.addNoteSync(note.note_id);
    }

    await protectNoteHistory(note.note_id, dataKey, protect);
}

async function protectNoteHistory(noteId, dataKey, protect) {
    const historyToChange = await sql.getResults("SELECT * FROM notes_history WHERE note_id = ? AND is_protected != ?", [noteId, protect]);

    for (const history of historyToChange) {
        if (protect) {
            history.note_title = data_encryption.encrypt(dataKey, data_encryption.noteTitleIv(history.note_history_id), history.note_title);
            history.note_text = data_encryption.encrypt(dataKey, data_encryption.noteTextIv(history.note_history_id), history.note_text);
            history.is_protected = true;
        }
        else {
            history.note_title = data_encryption.decryptString(dataKey, data_encryption.noteTitleIv(history.note_history_id), history.note_title);
            history.note_text = data_encryption.decryptString(dataKey, data_encryption.noteTextIv(history.note_history_id), history.note_text);
            history.is_protected = false;
        }

        await sql.execute("UPDATE notes_history SET note_title = ?, note_text = ?, is_protected = ? WHERE note_history_id = ?",
            [history.note_title, history.note_text, history.is_protected, history.note_history_id]);

        await sync_table.addNoteHistorySync(history.note_history_id);
    }
}

async function updateNote(noteId, newNote, ctx) {
    let noteTitleForHistory = newNote.detail.note_title;
    let noteTextForHistory = newNote.detail.note_text;

    if (newNote.detail.is_protected) {
        await encryptNote(newNote, ctx);
    }

    const origNoteDetail = await sql.getSingleResult("SELECT * FROM notes WHERE note_id = ?", [noteId]);

    const now = utils.nowTimestamp();

    const historySnapshotTimeInterval = parseInt(await options.getOption('history_snapshot_time_interval'));

    const historyCutoff = now - historySnapshotTimeInterval;

    const existingNoteHistoryId = await sql.getSingleValue("SELECT note_history_id FROM notes_history WHERE note_id = ? AND date_modified_from >= ?", [noteId, historyCutoff]);

    await sql.doInTransaction(async () => {
        if (!existingNoteHistoryId) {
            const newNoteHistoryId = utils.newNoteHistoryId();

            await sql.insert('notes_history', {
                note_history_id: newNoteHistoryId,
                note_id: noteId,
                note_title: noteTitleForHistory,
                note_text: noteTextForHistory,
                is_protected: false, // we don't care about encryption - this will be handled in protectNoteHistory()
                date_modified_from: now,
                date_modified_to: now
            });

            await sync_table.addNoteHistorySync(newNoteHistoryId);
        }

        await protectNoteHistory(noteId, ctx.getDataKeyOrNull(), newNote.detail.is_protected);

        await addNoteAudits(origNoteDetail, newNote.detail, ctx.browserId);

        await sql.execute("UPDATE notes SET note_title = ?, note_text = ?, is_protected = ?, date_modified = ? WHERE note_id = ?", [
            newNote.detail.note_title,
            newNote.detail.note_text,
            newNote.detail.is_protected,
            now,
            noteId]);

        await sql.remove("images", noteId);

        for (const img of newNote.images) {
            img.image_data = atob(img.image_data);

            await sql.insert("images", img);
        }

        await sql.remove("links", noteId);

        for (const link in newNote.links) {
            //await sql.insert("links", link);
        }

        await sync_table.addNoteSync(noteId);
    });
}

async function addNoteAudits(origNote, newNote, browserId) {
    const noteId = newNote.note_id;

    if (!origNote || newNote.note_title !== origNote.note_title) {
        await sql.deleteRecentAudits(audit_category.UPDATE_TITLE, browserId, noteId);
        await sql.addAudit(audit_category.UPDATE_TITLE, browserId, noteId);
    }

    if (!origNote || newNote.note_text !== origNote.note_text) {
        await sql.deleteRecentAudits(audit_category.UPDATE_CONTENT, browserId, noteId);
        await sql.addAudit(audit_category.UPDATE_CONTENT, browserId, noteId);
    }

    if (!origNote || newNote.is_protected !== origNote.is_protected) {
        const origIsProtected = origNote ? origNote.is_protected : null;

        await sql.addAudit(audit_category.PROTECTED, browserId, noteId, origIsProtected, newNote.is_protected);
    }
}


async function deleteNote(noteTreeId, browserId) {
    const now = utils.nowTimestamp();
    await sql.execute("UPDATE notes_tree SET is_deleted = 1, date_modified = ? WHERE note_tree_id = ?", [now, noteTreeId]);
    await sync_table.addNoteTreeSync(noteTreeId);

    const noteId = await sql.getSingleValue("SELECT note_id FROM notes_tree WHERE note_tree_id = ?", [noteTreeId]);

    const notDeletedNoteTreesCount = await sql.getSingleValue("SELECT COUNT(*) FROM notes_tree WHERE note_id = ? AND is_deleted = 0", [noteId]);

    if (!notDeletedNoteTreesCount) {
        await sql.execute("UPDATE notes SET is_deleted = 1, date_modified = ? WHERE note_id = ?", [now, noteId]);
        await sync_table.addNoteSync(noteId);

        const children = await sql.getResults("SELECT note_tree_id FROM notes_tree WHERE note_pid = ? AND is_deleted = 0", [noteId]);

        for (const child of children) {
            await deleteNote(child.note_tree_id, browserId);
        }

        await sql.addAudit(audit_category.DELETE_NOTE, browserId, noteTreeId);
    }
}

module.exports = {
    createNewNote,
    updateNote,
    addNoteAudits,
    deleteNote,
    protectNoteRecursively
};