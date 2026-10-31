// Switchboard Drive bridge. Runs as the Drive owner, so agents can read what the owner can
// see, but they can only create or change files inside WRITE_FOLDER_ID (and its subfolders).
// Deploy: Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone.
const SECRET = 'PASTE_SECRET_HERE';
const WRITE_FOLDER_ID = 'PASTE_FOLDER_ID_HERE';
const MAX_TEXT = 50000;

function doGet() {
  return ContentService.createTextOutput('Switchboard Drive bridge is running.');
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ error: 'Bad request' }); }
  if (req.key !== SECRET) return out({ error: 'Unauthorized' });
  try { return out(handle(req)); } catch (err) { return out({ error: String(err && err.message || err) }); }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function handle(req) {
  switch (req.action) {
    case 'search': return search(req.query);
    case 'list': return list(req.folder_id || WRITE_FOLDER_ID);
    case 'read': return read(req.file_id);
    case 'create_doc': return createDoc(req.title, req.content, req.folder_id);
    case 'update_doc': return updateDoc(req.file_id, req.content, req.mode);
    case 'create_folder': return createFolder(req.name, req.parent_id);
    default: throw new Error('Unknown action: ' + req.action);
  }
}

function info(f) {
  return { id: f.getId(), title: f.getName(), type: f.getMimeType(), url: f.getUrl(), modified: f.getLastUpdated().toISOString() };
}

function search(query) {
  const q = String(query || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const it = DriveApp.searchFiles("trashed = false and (title contains '" + q + "' or fullText contains '" + q + "')");
  const files = [];
  while (it.hasNext() && files.length < 20) files.push(info(it.next()));
  return { files: files };
}

function list(folderId) {
  const folder = DriveApp.getFolderById(folderId);
  const files = [], folders = [];
  const fi = folder.getFiles();
  while (fi.hasNext() && files.length < 100) files.push(info(fi.next()));
  const fo = folder.getFolders();
  while (fo.hasNext() && folders.length < 100) { const f = fo.next(); folders.push({ id: f.getId(), title: f.getName(), type: 'folder' }); }
  return { folder: folder.getName(), files: files, folders: folders };
}

function read(id) {
  const f = DriveApp.getFileById(id);
  const type = f.getMimeType();
  let text;
  if (type === MimeType.GOOGLE_DOCS) text = DocumentApp.openById(id).getBody().getText();
  else if (type === MimeType.GOOGLE_SHEETS) text = SpreadsheetApp.openById(id).getSheets().map(function (s) {
    return '# ' + s.getName() + '\n' + s.getDataRange().getDisplayValues().map(function (r) { return r.join('\t'); }).join('\n');
  }).join('\n\n');
  else if (type === MimeType.GOOGLE_SLIDES) text = SlidesApp.openById(id).getSlides().map(function (s, i) {
    return 'Slide ' + (i + 1) + ': ' + s.getShapes().map(function (sh) { try { return sh.getText().asString(); } catch (e) { return ''; } }).join(' ');
  }).join('\n');
  else if (/^text\/|json|csv|xml/.test(type)) text = f.getBlob().getDataAsString();
  else return Object.assign(info(f), { text: null, note: 'This file type cannot be read as text.' });
  return Object.assign(info(f), { text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT });
}

// True if the file or folder sits inside the Switchboard folder (any depth up to 10).
function insideWriteFolder(item) {
  if (item.getId() === WRITE_FOLDER_ID) return true;
  let level = [];
  const ps = item.getParents();
  while (ps.hasNext()) level.push(ps.next());
  for (let depth = 0; depth < 10 && level.length; depth++) {
    const next = [];
    for (let i = 0; i < level.length; i++) {
      if (level[i].getId() === WRITE_FOLDER_ID) return true;
      const pp = level[i].getParents();
      while (pp.hasNext()) next.push(pp.next());
    }
    level = next;
  }
  return false;
}

function createDoc(title, content, folderId) {
  const folder = DriveApp.getFolderById(folderId || WRITE_FOLDER_ID);
  if (!insideWriteFolder(folder)) throw new Error('New files can only go in the Switchboard folder.');
  const doc = DocumentApp.create(String(title || 'Untitled'));
  doc.getBody().setText(String(content || ''));
  doc.saveAndClose();
  const file = DriveApp.getFileById(doc.getId());
  file.moveTo(folder);
  return info(file);
}

function updateDoc(id, content, mode) {
  const file = DriveApp.getFileById(id);
  if (!insideWriteFolder(file)) throw new Error('Only files in the Switchboard folder can be changed.');
  if (file.getMimeType() !== MimeType.GOOGLE_DOCS) throw new Error('Only Google Docs can be updated.');
  const body = DocumentApp.openById(id).getBody();
  if (mode === 'replace') body.setText(String(content || ''));
  else body.appendParagraph(String(content || ''));
  return info(file);
}

function createFolder(name, parentId) {
  const parent = DriveApp.getFolderById(parentId || WRITE_FOLDER_ID);
  if (!insideWriteFolder(parent)) throw new Error('Folders can only be created inside the Switchboard folder.');
  const title = String(name || '').trim();
  if (!title) throw new Error('A folder name is required.');
  const existing = parent.getFoldersByName(title);
  const existed = existing.hasNext();
  const folder = existed ? existing.next() : parent.createFolder(title);
  return { id: folder.getId(), title: folder.getName(), type: 'folder', url: folder.getUrl(), existed: existed };
}
