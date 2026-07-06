import os
import json
import uuid
import shutil
import asyncio
import websockets
from datetime import datetime, timezone
import threading

from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, 
    QLabel, QScrollArea, QPushButton, QSplitter, QTextEdit, QLineEdit, 
    QMessageBox, QFrame, QSizePolicy, QDialog
)
from PyQt5.QtCore import Qt, pyqtSignal

class DuplicateFileDialog(QDialog):
    def __init__(self, file_name, parent=None):
        super().__init__(parent)
        self.setWindowTitle("File Already Exists")
        self.action = "cancel"

        layout = QVBoxLayout(self)
        layout.addWidget(QLabel(f"A file with the name '{file_name}' already exists."))
        layout.addWidget(QLabel("Do you want to overwrite it, or rename the new file?"))

        self.name_edit = QLineEdit(file_name)
        layout.addWidget(self.name_edit)

        button_layout = QHBoxLayout()
        self.btn_overwrite = QPushButton("Overwrite")
        self.btn_rename = QPushButton("Rename")
        self.btn_cancel = QPushButton("Cancel")

        button_layout.addWidget(self.btn_overwrite)
        button_layout.addWidget(self.btn_rename)
        button_layout.addWidget(self.btn_cancel)
        layout.addLayout(button_layout)

        self.btn_overwrite.clicked.connect(self.on_overwrite)
        self.btn_rename.clicked.connect(self.on_rename)
        self.btn_cancel.clicked.connect(self.reject)

    def on_overwrite(self):
        self.action = "overwrite"
        self.accept()

    def on_rename(self):
        self.action = "rename"
        self.accept()

TRANSFERS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'transfers')
METADATA_FILE = os.path.join(TRANSFERS_DIR, 'metadata.json')

def load_metadata():
    if not os.path.exists(METADATA_FILE):
        return []
    with open(METADATA_FILE, 'r', encoding='utf-8') as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return []

def save_metadata(metadata):
    os.makedirs(TRANSFERS_DIR, exist_ok=True)
    with open(METADATA_FILE, 'w', encoding='utf-8') as f:
        json.dump(metadata, f, indent=2)

def notify_servers():
    async def _notify():
        try:
            # Assuming the default port is 9734 based on config
            async with websockets.connect("ws://127.0.0.1:9734") as ws:
                msg = {
                    "id": str(uuid.uuid4()),
                    "type": "server_reload_files",
                    "source": "local_ui_drop",
                    "target": "server",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "flags": {},
                    "payload": {}
                }
                await ws.send(json.dumps(msg))
        except Exception as e:
            print(f"Could not notify server: {e}")
            
    def run_notify():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(_notify())
        
    threading.Thread(target=run_notify, daemon=True).start()

class FileWidget(QFrame):
    clicked = pyqtSignal(dict)
    deleteRequested = pyqtSignal(dict)
    
    def __init__(self, file_info, parent=None):
        super().__init__(parent)
        self.file_info = file_info
        
        self.setFocusPolicy(Qt.StrongFocus)
        self.setFrameShape(QFrame.StyledPanel)
        self.setFrameShadow(QFrame.Raised)
        
        layout = QVBoxLayout(self)
        layout.setContentsMargins(5, 5, 5, 5)
        
        self.name_label = QLabel(f"📄 {file_info.get('fileName', 'Unknown')}")
        self.name_label.setStyleSheet("font-weight: bold;")
        
        self.size_label = QLabel(f"Size: {file_info.get('fileSize', 0)} bytes")
        
        self.type_label = QLabel(f"Type: {file_info.get('fileType', 'unknown')}")
        
        layout.addWidget(self.name_label)
        layout.addWidget(self.size_label)
        layout.addWidget(self.type_label)
    
    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.setFocus()
            self.clicked.emit(self.file_info)
        super().mousePressEvent(event)

    def keyPressEvent(self, event):
        if event.key() == Qt.Key_Delete:
            self.deleteRequested.emit(self.file_info)
        else:
            super().keyPressEvent(event)

class FolderWidget(QFrame):
    def __init__(self, folder_name, parent=None):
        super().__init__(parent)
        self.setFrameShape(QFrame.StyledPanel)
        self.setFrameShadow(QFrame.Raised)
        
        layout = QVBoxLayout(self)
        layout.setContentsMargins(5, 5, 5, 5)
        
        self.name_label = QLabel(f"📁 {folder_name}")
        self.name_label.setStyleSheet("font-weight: bold;")
        layout.addWidget(self.name_label)

class DropArea(QScrollArea):
    fileDropped = pyqtSignal(list)
    
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAcceptDrops(True)
        self.setWidgetResizable(True)
        
    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls():
            event.accept()
        else:
            event.ignore()
            
    def dropEvent(self, event):
        files = [url.toLocalFile() for url in event.mimeData().urls()]
        self.fileDropped.emit(files)

class FileTransferUI(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("File Transfer Manager")
        self.resize(800, 600)
        
        self.metadata = load_metadata()
        
        main_widget = QWidget()
        self.setCentralWidget(main_widget)
        
        main_layout = QHBoxLayout(main_widget)
        
        splitter = QSplitter(Qt.Horizontal)
        main_layout.addWidget(splitter)
        
        # Left Panel - File List (Drag and Drop enabled)
        self.left_panel = QWidget()
        left_layout = QVBoxLayout(self.left_panel)
        
        self.drop_area = DropArea()
        self.drop_area.fileDropped.connect(self.handle_files_dropped)
        
        self.list_widget = QWidget()
        self.list_layout = QVBoxLayout(self.list_widget)
        self.list_layout.setAlignment(Qt.AlignTop)
        
        self.drop_area.setWidget(self.list_widget)
        left_layout.addWidget(QLabel("Files & Folders (Drag files here to add)"))
        left_layout.addWidget(self.drop_area)
        
        # Right Panel - Editor
        self.right_panel = QWidget()
        right_layout = QVBoxLayout(self.right_panel)
        
        self.editor_title = QLabel("Edit File:")
        self.file_name_editor = QLineEdit()
        self.file_name_editor.setPlaceholderText("File Name")
        
        self.text_editor = QTextEdit()
        self.save_button = QPushButton("Save File")
        self.save_button.clicked.connect(self.save_current_file)
        
        right_layout.addWidget(self.editor_title)
        right_layout.addWidget(QLabel("Name:"))
        right_layout.addWidget(self.file_name_editor)
        right_layout.addWidget(QLabel("Content (Text files only):"))
        right_layout.addWidget(self.text_editor)
        right_layout.addWidget(self.save_button)
        
        splitter.addWidget(self.left_panel)
        splitter.addWidget(self.right_panel)
        
        self.current_file_info = None
        self.refresh_list()
        
    def refresh_list(self):
        # Clear current list
        while self.list_layout.count():
            child = self.list_layout.takeAt(0)
            if child.widget():
                child.widget().deleteLater()
                
        self.metadata = load_metadata()
        
        # Display files from metadata
        for file_info in self.metadata:
            fw = FileWidget(file_info)
            fw.clicked.connect(self.load_file_to_editor)
            fw.deleteRequested.connect(self.prompt_delete_file)
            self.list_layout.addWidget(fw)
            
    def handle_files_dropped(self, files):
        os.makedirs(TRANSFERS_DIR, exist_ok=True)
        for f in files:
            if os.path.isfile(f):
                file_name = os.path.basename(f)
                
                existing_entry = next((item for item in self.metadata if item.get("fileName") == file_name), None)
                if existing_entry:
                    dialog = DuplicateFileDialog(file_name, self)
                    if dialog.exec_() == QDialog.Rejected:
                        continue
                        
                    action = dialog.action
                    new_file_name = dialog.name_edit.text()
                    
                    if action == "rename" and new_file_name != file_name:
                        file_name = new_file_name
                        existing_entry = None
                
                if existing_entry:
                    old_path = existing_entry.get("storedPath", "")
                    old_real_path = os.path.join(TRANSFERS_DIR, os.path.basename(old_path))
                    if os.path.exists(old_real_path):
                        try:
                            os.remove(old_real_path)
                        except OSError:
                            pass
                    self.metadata.remove(existing_entry)
                
                file_id = f"dropped-{str(uuid.uuid4())[:8]}"
                stored_name = f"{file_id}_{file_name}"
                dest_path = os.path.join(TRANSFERS_DIR, stored_name)
                
                shutil.copy2(f, dest_path)
                
                # Create metadata entry
                new_entry = {
                    "fileId": file_id,
                    "fileName": file_name,
                    "fileType": "application/octet-stream", # Best guess or use mimetypes
                    "fileSize": os.path.getsize(dest_path),
                    "storedPath": dest_path,
                    "source": "local_ui_drop",
                    "target": "server",
                    "sentAt": datetime.now(timezone.utc).isoformat(),
                    "storedAt": datetime.now(timezone.utc).isoformat(),
                    "storedBy": "local_ui"
                }
                self.metadata.insert(0, new_entry)
        
        save_metadata(self.metadata)
        self.refresh_list()
        notify_servers()

    def load_file_to_editor(self, file_info):
        self.current_file_info = file_info
        self.file_name_editor.setText(file_info.get("fileName", ""))
        
        stored_path = file_info.get("storedPath", "")
        # Resolve real path since storedPath might have old directory structure
        real_path = os.path.join(TRANSFERS_DIR, os.path.basename(stored_path))
        
        if os.path.exists(real_path):
            try:
                with open(real_path, 'r', encoding='utf-8') as f:
                    self.text_editor.setText(f.read())
            except UnicodeDecodeError:
                self.text_editor.setText("[Binary or non-UTF-8 file cannot be displayed]")
        else:
            self.text_editor.setText("[File not found on disk]")
            
    def prompt_delete_file(self, file_info):
        file_name = file_info.get("fileName", "Unknown")
        reply = QMessageBox.question(self, 'Delete File', 
                                     f"Are you sure you want to delete '{file_name}'?",
                                     QMessageBox.Yes | QMessageBox.No, QMessageBox.No)
                                     
        if reply == QMessageBox.Yes:
            stored_path = file_info.get("storedPath", "")
            real_path = os.path.join(TRANSFERS_DIR, os.path.basename(stored_path))
            if os.path.exists(real_path):
                try:
                    os.remove(real_path)
                except OSError:
                    pass
            
            file_id = file_info.get("fileId")
            self.metadata = [item for item in self.metadata if item.get("fileId") != file_id]
            save_metadata(self.metadata)
            
            if self.current_file_info and self.current_file_info.get("fileId") == file_id:
                self.current_file_info = None
                self.file_name_editor.clear()
                self.text_editor.clear()
                
            self.refresh_list()
            notify_servers()

    def save_current_file(self):
        if not self.current_file_info:
            return
            
        new_name = self.file_name_editor.text()
        
        stored_path = self.current_file_info.get("storedPath", "")
        old_real_path = os.path.join(TRANSFERS_DIR, os.path.basename(stored_path))
        
        # If name changed, we could decide to change storedPath as well, but usually 
        # it's best just to track the original format: fileId_fileName
        file_id = self.current_file_info.get("fileId", "unknown")
        new_basename = f"{file_id}_{new_name}"
        new_real_path = os.path.join(TRANSFERS_DIR, new_basename)
        
        # Rename physical file if name changed
        if old_real_path != new_real_path and os.path.exists(old_real_path):
            os.rename(old_real_path, new_real_path)
            self.current_file_info["fileName"] = new_name
            self.current_file_info["storedPath"] = new_real_path
            
        # Write text content
        if not self.text_editor.toPlainText().startswith("[Binary"):
            with open(new_real_path, 'w', encoding='utf-8') as f:
                f.write(self.text_editor.toPlainText())
                
        # Update metadata size
        if os.path.exists(new_real_path):
            self.current_file_info["fileSize"] = os.path.getsize(new_real_path)
            
        save_metadata(self.metadata)
        self.refresh_list()
        notify_servers()
        QMessageBox.information(self, "Saved", "File saved and metadata updated.")

if __name__ == '__main__':
    import sys
    app = QApplication(sys.argv)
    
    # Simple styling
    app.setStyleSheet("""
        QMainWindow, QWidget {
            background-color: #1e1e1e;
            color: #d4d4d4;
        }
        QLineEdit, QTextEdit {
            background-color: #252526;
            color: #d4d4d4;
            border: 1px solid #3c3c3c;
            border-radius: 4px;
            padding: 4px;
        }
        QPushButton {
            background-color: #0e639c;
            color: #ffffff;
            border: none;
            border-radius: 4px;
            padding: 8px 16px;
        }
        QPushButton:hover {
            background-color: #1177bb;
        }
        QPushButton:pressed {
            background-color: #094771;
        }
        FileWidget {
            background-color: #2d2d30;
            border-radius: 5px;
            margin-bottom: 5px;
            border: 1px solid #3e3e42;
            color: #d4d4d4;
        }
        FileWidget:hover {
            background-color: #3e3e42;
            border: 1px solid #555555;
        }
        FolderWidget {
            background-color: #252526;
            border-radius: 5px;
            margin-bottom: 5px;
            border: 1px solid #3e3e42;
            color: #d4d4d4;
        }
        DropArea {
            border: 2px dashed #555;
            background-color: #1e1e1e;
        }
        QSplitter::handle {
            background-color: #3c3c3c;
        }
    """)
    
    window = FileTransferUI()
    window.show()
    sys.exit(app.exec_())
