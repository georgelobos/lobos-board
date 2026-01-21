import React, { useState, useEffect } from 'react';
import {
    Square, Circle, Triangle, Edit3, Eraser, MousePointer2,
    Trash2, Undo, Redo, Copy, Clipboard as ClipboardIcon, Scissors, CopyPlus, RotateCcw,
    Sun, Moon, Upload, Bold, Underline as UnderlineIcon, ArrowUpRight,
    Search, ZoomIn, ZoomOut, Share2
} from 'lucide-react';
import './index.css';
import { useWhiteboard } from './hooks/useWhiteboard';

const App: React.FC = () => {
    const [activeTool, setActiveTool] = useState<string>('pen');
    const [brushColor, setBrushColor] = useState<string>('#6366f1');
    const [brushSize, setBrushSize] = useState<number>(5);

    // Text styling states
    const [textFontSize, setTextFontSize] = useState<number>(24);
    const [textFontFamily, setTextFontFamily] = useState<string>('Inter, sans-serif');
    const [isBold, setIsBold] = useState<boolean>(false);
    const [isUnderline, setIsUnderline] = useState<boolean>(false);
    const [isDashed, setIsDashed] = useState<boolean>(false);

    const [roomId] = useState<string>(() => {
        const params = new URLSearchParams(window.location.search);
        return params.get('room') || 'room-' + Math.random().toString(36).substr(2, 9);
    });
    const [isReadOnly] = useState<boolean>(() => {
        const params = new URLSearchParams(window.location.search);
        return params.get('view') === 'true';
    });

    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        const saved = localStorage.getItem('lobos-board-theme');
        return (saved as 'light' | 'dark') || 'light';
    });

    // 1. URL Persistence Logic
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const room = params.get('room');

        if (!room) {
            const newUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?room=${roomId}`;
            window.history.replaceState({ path: newUrl }, '', newUrl);
        }

        console.log(`DEBUG: App mounted - Room: ${roomId}, ReadOnly: ${isReadOnly}`);
    }, []);

    const shareBoard = () => {
        // Use the frontend tunnel URL if available, otherwise use current location
        const baseUrl = import.meta.env.VITE_FRONTEND_URL || `${window.location.protocol}//${window.location.host}${window.location.pathname}`;
        const shareUrl = `${baseUrl}?room=${roomId}&view=true`;
        navigator.clipboard.writeText(shareUrl).then(() => {
            alert('¡Enlace de "Solo Lectura" copiado para tus estudiantes! 🔗\n\n' + shareUrl);
        });
    };


    const {
        setCanvasRef, addShape, clearCanvas, deleteSelected, undo, redo, testDraw, copy, paste, cut, duplicate, resetWhiteboard, uploadImage, canvas, zoom, resetZoom, zoomIn, zoomOut, isConnected
    } = useWhiteboard({
        activeTool,
        color: brushColor,
        size: brushSize,
        fontSize: textFontSize,
        fontFamily: textFontFamily,
        fontWeight: isBold ? 'bold' : 'normal',
        underline: isUnderline,
        isDashed,
        isReadOnly,
        roomId
    });

    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, visible: boolean }>({ x: 0, y: 0, visible: false });

    // Apply theme immediately on mount and whenever it changes
    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('lobos-board-theme', theme);
        console.log('DEBUG: Theme applied:', theme);
    }, [theme]);

    const toggleTheme = () => {
        setTheme(prev => prev === 'light' ? 'dark' : 'light');
    };

    useEffect(() => {
        const handleClick = () => setContextMenu(prev => prev.visible ? { ...prev, visible: false } : prev);

        const handleBrowserContextMenu = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('.main-canvas-area') || target.closest('.canvas-container')) {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, visible: true });
            }
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            // Check if user is typing in a text object
            if (canvas) {
                const activeObjects = canvas.getActiveObjects();
                const isEditingText = activeObjects.some((obj: any) => obj.type === 'i-text' && obj.isEditing);

                // If editing text, don't intercept standard editing keys
                if (isEditingText && (e.key === 'Delete' || e.key === 'Backspace' || (e.ctrlKey && e.key.toLowerCase() === 'z') || (e.ctrlKey && e.key.toLowerCase() === 'y'))) {
                    return;
                }
            }

            if (e.ctrlKey || e.metaKey) {
                switch (e.key.toLowerCase()) {
                    case 'c':
                        e.preventDefault();
                        copy();
                        break;
                    case 'v':
                        e.preventDefault();
                        paste();
                        break;
                    case 'z':
                        e.preventDefault();
                        undo();
                        break;
                    case 'y':
                        e.preventDefault();
                        redo();
                        break;
                    case 'x':
                        e.preventDefault();
                        cut();
                        break;
                    case 'd':
                        e.preventDefault();
                        duplicate();
                        break;
                }
            } else {
                // Non-Ctrl shortcuts
                if (e.key === 'Delete' || e.key === 'Backspace') {
                    e.preventDefault();
                    deleteSelected();
                }
            }
        };

        window.addEventListener('click', handleClick);
        window.addEventListener('contextmenu', handleBrowserContextMenu);
        window.addEventListener('keydown', handleKeyDown);

        return () => {
            window.removeEventListener('click', handleClick);
            window.removeEventListener('contextmenu', handleBrowserContextMenu);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [canvas, copy, paste, cut, duplicate, undo, redo, deleteSelected]);

    const handleToolClick = (toolId: string) => {
        if (['square', 'circle', 'triangle'].includes(toolId)) {
            setActiveTool('select');
            // Use setTimeout to ensure state update completes before shape creation
            setTimeout(() => addShape(toolId), 0);
        } else {
            setActiveTool(toolId);
        }
    };

    const colorPresets = ['#6366f1', '#f43f5e', '#10b981', '#f59e0b', '#ffffff', '#000000'];
    const fontFamilies = [
        { name: 'Sans-Serif', value: 'Inter, system-ui, sans-serif' },
        { name: 'Serif', value: 'Georgia, serif' },
        { name: 'Monospace', value: 'monospace' },
        { name: 'Cursive', value: 'cursive' }
    ];

    return (
        <div className="app-layout" onContextMenu={(e) => e.preventDefault()}>
            <header className="header-centered">
                <h1 className="title-interactive" onClick={() => testDraw()} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    LOBOS-BOARD
                    <span
                        className={`status-dot ${isConnected ? 'online' : 'offline'}`}
                        title={isConnected ? 'Conectado al servidor' : 'Desconectado - Intentando reconectar...'}
                    />
                </h1>

                <div className="divider" />

                <button className="toolbar-btn text-primary" onClick={shareBoard} title="Compartir pizarra (Link de solo lectura)">
                    <Share2 size={20} strokeWidth={2.5} />
                </button>

                <div className="divider" />

                {!isReadOnly && (
                    <>
                        <div className="history-controls">
                            <button className="toolbar-btn" onClick={undo} title="Deshacer (Ctrl+Z)">
                                <Undo size={18} />
                            </button>
                            <button className="toolbar-btn" onClick={redo} title="Rehacer (Ctrl+Y)">
                                <Redo size={18} />
                            </button>
                        </div>

                        <div className="divider" />

                        <div className="zoom-controls">
                            <button className="toolbar-btn" onClick={zoomOut} title="Alejar">
                                <ZoomOut size={18} />
                            </button>
                            <button className="toolbar-btn zoom-level-btn" onClick={resetZoom} title="Resetear Zoom (100%)">
                                {Math.round(zoom * 100)}%
                            </button>
                            <button className="toolbar-btn" onClick={zoomIn} title="Acercar">
                                <ZoomIn size={18} />
                            </button>
                        </div>

                        <div className="divider" />

                        <div className="controls-group">
                            <div className="size-control">
                                <input
                                    type="range" min="1" max="50"
                                    value={brushSize}
                                    onChange={(e) => setBrushSize(parseInt(e.target.value))}
                                    title="Tamaño del pincel"
                                />
                                <span className="size-label">{brushSize}px</span>
                            </div>

                            {!(activeTool === 'text' || (canvas && canvas.getActiveObject()?.type === 'i-text')) && (
                                <div className="color-presets">
                                    {colorPresets.map(c => (
                                        <button
                                            key={c}
                                            className={`preset-btn ${brushColor === c ? 'active' : ''}`}
                                            style={{ backgroundColor: c }}
                                            onClick={() => setBrushColor(c)}
                                            title={c === '#ffffff' ? 'Blanco' : c === '#000000' ? 'Negro' : 'Color'}
                                        />
                                    ))}
                                    <input
                                        type="color"
                                        value={brushColor}
                                        onChange={(e) => setBrushColor(e.target.value)}
                                        className="color-picker"
                                        title="Selector de color personalizado"
                                    />
                                </div>
                            )}

                            <div className="divider" />

                            {(activeTool === 'pen' || activeTool === 'arrow') && (
                                <button
                                    className={`toolbar-btn ${isDashed ? 'active' : ''}`}
                                    onClick={() => setIsDashed(!isDashed)}
                                    title={isDashed ? 'Línea continua' : 'Línea segmentada'}
                                >
                                    <div style={{
                                        width: '32px',
                                        height: '5px',
                                        borderRadius: '2px',
                                        backgroundImage: 'repeating-linear-gradient(to right, currentColor, currentColor 9px, transparent 9px, transparent 16px)'
                                    }} />
                                </button>
                            )}
                        </div>
                    </>
                )}

                <div className="divider" />

                {/* Text Styling Controls */}
                {(activeTool === 'text' || (canvas && canvas.getActiveObject()?.type === 'i-text')) && (
                    <>
                        <div className="controls-group text-controls">
                            <select
                                className="toolbar-select"
                                value={textFontFamily}
                                onChange={(e) => setTextFontFamily(e.target.value)}
                                title="Tipo de fuente"
                            >
                                {fontFamilies.map(f => (
                                    <option key={f.value} value={f.value}>{f.name}</option>
                                ))}
                            </select>

                            <div className="size-control">
                                <input
                                    type="number" className="toolbar-input" min="8" max="200"
                                    value={textFontSize}
                                    onChange={(e) => setTextFontSize(parseInt(e.target.value) || 24)}
                                    title="Tamaño de letra"
                                />
                                <span className="size-label">pt</span>
                            </div>

                            <button
                                className={`toolbar-btn ${isBold ? 'active' : ''}`}
                                onClick={() => setIsBold(!isBold)}
                                title="Negrita"
                            >
                                <Bold size={18} />
                            </button>
                            <button
                                className={`toolbar-btn ${isUnderline ? 'active' : ''}`}
                                onClick={() => setIsUnderline(!isUnderline)}
                                title="Subrayado"
                            >
                                <UnderlineIcon size={18} />
                            </button>

                            <div className="divider" style={{ height: '20px', margin: '0 8px' }} />

                            <div className="color-presets">
                                {colorPresets.map(c => (
                                    <button
                                        key={c}
                                        className={`preset-btn ${brushColor === c ? 'active' : ''}`}
                                        style={{ backgroundColor: c, width: '20px', height: '20px' }}
                                        onClick={() => setBrushColor(c)}
                                        title={c === '#ffffff' ? 'Blanco' : c === '#000000' ? 'Negro' : 'Color de texto'}
                                    />
                                ))}
                            </div>
                        </div>
                        <div className="divider" />
                    </>
                )}

                <button
                    className="toolbar-btn"
                    onClick={toggleTheme}
                    title={theme === 'light' ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro'}
                >
                    {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
                </button>

                {!isReadOnly && (
                    <>
                        <div className="divider" />
                        <button className="toolbar-btn text-rose-400" onClick={clearCanvas} title="Borrar todo">
                            <Trash2 size={20} />
                        </button>
                        <div className="divider" />
                        <button
                            className="toolbar-btn text-orange-400"
                            onClick={() => {
                                if (window.confirm('¿Estás seguro de que deseas reiniciar toda la pizarra? Esto borrará el historial y el portapapeles.')) {
                                    resetWhiteboard();
                                }
                            }}
                            title="Reiniciar pizarra (Hard Reset)"
                        >
                            <RotateCcw size={20} />
                        </button>
                        <div className="divider" />
                        <input
                            type="file"
                            id="media-upload"
                            accept="image/*,application/pdf,video/mp4,video/webm,video/ogg,audio/mpeg,audio/wav,audio/ogg,audio/mp4"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) {
                                    uploadImage(file);
                                    e.target.value = ''; // Reset input
                                }
                            }}
                        />
                        <button
                            className="toolbar-btn"
                            onClick={() => document.getElementById('media-upload')?.click()}
                            title="Subir imagen, PDF, video o audio"
                        >
                            <Upload size={20} />
                        </button>
                    </>
                )}
            </header>

            {!isReadOnly && (
                <aside className="sidebar-left">
                    {[
                        { id: 'select', icon: <MousePointer2 size={24} strokeWidth={3} /> },
                        { id: 'pen', icon: <Edit3 size={24} strokeWidth={3} /> },
                        { id: 'arrow', icon: <ArrowUpRight size={24} strokeWidth={4} /> },
                        { id: 'zoom', icon: <Search size={24} strokeWidth={3} /> },
                        { id: 'text', icon: <span style={{ fontSize: '24px', fontWeight: '900' }}>T</span> },
                        { id: 'eraser', icon: <Eraser size={24} strokeWidth={3} /> },
                        { id: 'square', icon: <Square size={24} strokeWidth={3} /> },
                        { id: 'circle', icon: <Circle size={24} strokeWidth={3} /> },
                        { id: 'triangle', icon: <Triangle size={24} strokeWidth={3} /> }
                    ].map(tool => (
                        <button
                            key={tool.id}
                            className={`toolbar-btn ${activeTool === tool.id ? 'active' : ''}`}
                            onClick={() => handleToolClick(tool.id)}
                        >
                            {tool.icon}
                        </button>
                    ))}
                </aside>
            )}

            <main className="main-canvas-area">
                <canvas ref={setCanvasRef} />
            </main>

            {contextMenu.visible && (
                <div
                    className="context-menu"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                >
                    <div className="context-menu-item" onClick={() => {
                        copy();
                        setContextMenu(prev => ({ ...prev, visible: false }));
                    }}>
                        <Copy size={16} />
                        Copiar
                    </div>
                    <div className="context-menu-item" onClick={() => {
                        cut();
                        setContextMenu(prev => ({ ...prev, visible: false }));
                    }}>
                        <Scissors size={16} />
                        Cortar
                    </div>
                    <div className="context-menu-item" onClick={() => {
                        paste();
                        setContextMenu(prev => ({ ...prev, visible: false }));
                    }}>
                        <ClipboardIcon size={16} />
                        Pegar
                    </div>
                    <div className="context-menu-item" onClick={() => {
                        duplicate();
                        setContextMenu(prev => ({ ...prev, visible: false }));
                    }}>
                        <CopyPlus size={16} />
                        Duplicar
                    </div>
                    <div className="context-menu-divider" />
                    <div className="context-menu-item danger" onClick={() => {
                        deleteSelected();
                        setContextMenu(prev => ({ ...prev, visible: false }));
                    }}>
                        <Trash2 size={16} />
                        Eliminar Selección
                    </div>
                </div>
            )}
        </div>
    );
};

export default App;
