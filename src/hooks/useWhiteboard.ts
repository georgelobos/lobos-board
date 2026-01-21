import { useEffect, useRef, useState, useCallback } from 'react';
import * as fabricModule from 'fabric';
import { io, Socket } from 'socket.io-client';

const fabric = (fabricModule as any).fabric || fabricModule;

export interface WhiteboardHookProps {
    activeTool: string;
    color: string;
    size: number;
    fontSize?: number;
    fontFamily?: string;
    fontWeight?: string;
    underline?: boolean;
    isDashed?: boolean;
    isReadOnly: boolean;
    roomId: string;
}

export const useWhiteboard = ({
    activeTool, color, size, fontSize = 24, fontFamily = 'Inter, sans-serif', fontWeight = 'normal', underline = false, isDashed = false, isReadOnly, roomId
}: WhiteboardHookProps) => {
    const [canvas, setCanvas] = useState<any>(null);
    const [zoom, setZoom] = useState<number>(1);
    const [isConnected, setIsConnected] = useState<boolean>(false);
    const canvasRef = useRef<any>(null);
    const socketRef = useRef<Socket | null>(null);

    // State for panning and clicking
    const isPanningRef = useRef<boolean>(false);
    const lastPanPosRef = useRef<{ x: number, y: number } | null>(null);
    const mouseDownPointRef = useRef<{ x: number, y: number } | null>(null);
    const activeToolRef = useRef<string>(activeTool);
    const isEraserDraggingRef = useRef<boolean>(false);

    // Sync ref with state
    useEffect(() => {
        activeToolRef.current = activeTool;
    }, [activeTool]);

    const historyRef = useRef<{ undo: string[], redo: string[] }>({ undo: [], redo: [] });
    const isRestoringRef = useRef<boolean>(false);
    const clipboardRef = useRef<any>(null);

    // Save current canvas state to history
    const saveHistory = useCallback(() => {
        if (isRestoringRef.current) return;

        const c = canvasRef.current;
        if (!c) return;

        // Include custom ID and composite operation in the state
        const json = JSON.stringify(c.toJSON(['id', 'globalCompositeOperation', 'objectCaching']));

        // Prevent duplicate states (multiple rapid calls)
        const lastState = historyRef.current.undo[historyRef.current.undo.length - 1];
        if (lastState === json) return;

        historyRef.current.undo.push(json);
        historyRef.current.redo = []; // Clear redo on new action

        console.log(`DEBUG: History saved. Undo stack: ${historyRef.current.undo.length}, Redo stack: ${historyRef.current.redo.length}`);
    }, []);

    // Helper to get Fabric constructors safely
    const getConstructor = useCallback((name: string) => {
        return fabric[name] || (fabricModule as any)[name] || (window as any).fabric?.[name];
    }, []);

    const [container, setContainer] = useState<HTMLCanvasElement | null>(null);
    const setCanvasRef = useCallback((el: HTMLCanvasElement | null) => {
        setContainer(el);
    }, []);

    // 1. Initial Fabric set up
    useEffect(() => {
        if (!container || canvasRef.current) return;

        console.log("DEBUG: Initializing Fabric on container:", container);
        const CanvasConstructor = getConstructor('Canvas');
        if (!CanvasConstructor) {
            console.error("DEBUG: Fabric Canvas constructor not found!");
            return;
        }

        try {
            const fabricCanvas = new CanvasConstructor(container, {
                backgroundColor: 'transparent',
                preserveObjectStacking: true,
                fireRightClick: true,
                width: container.parentElement?.clientWidth || window.innerWidth,
                height: container.parentElement?.clientHeight || window.innerHeight
            });

            fabricCanvas.calcOffset();

            // Handle Resize
            const handleResize = () => {
                if (container.parentElement && fabricCanvas) {
                    fabricCanvas.setDimensions({
                        width: container.parentElement.clientWidth,
                        height: container.parentElement.clientHeight
                    });
                    fabricCanvas.calcOffset();
                    fabricCanvas.renderAll();
                }
            };
            window.addEventListener('resize', handleResize);
            (fabricCanvas as any)._resizeHandler = handleResize;

            // Save initial empty state
            const initialJson = JSON.stringify(fabricCanvas.toJSON(['id', 'globalCompositeOperation', 'objectCaching', 'remote']));
            historyRef.current.undo = [initialJson];
            historyRef.current.redo = [];

            canvasRef.current = fabricCanvas;
            setCanvas(fabricCanvas);
        } catch (err) {
            console.error("DEBUG: Canvas initialization error:", err);
        }
    }, [container, getConstructor]);

    // Secondary effect for one-time listeners and sockets
    useEffect(() => {
        const fabricCanvas = canvas;
        if (!fabricCanvas) return;

        // 1. History listeners
        fabricCanvas.on('object:added', (e: any) => {
            if (e.target && !e.target.remote) saveHistory();

            const tool = activeToolRef.current;
            if (isReadOnly || tool === 'eraser') {
                e.target.set({ selectable: false, evented: !isReadOnly, objectCaching: false });
            } else if (tool === 'zoom') {
                e.target.set({ selectable: false, evented: false });
            }
        });
        fabricCanvas.on('object:removed', (e: any) => {
            if (e.target && !e.target.remote) saveHistory();

            if (activeToolRef.current === 'eraser') {
                // Broadcast erase if not remote
                if (e.target.id && !e.target.remote) {
                    socketRef.current?.emit('canvas-event', { room: roomId, type: 'object:removed', id: e.target.id });
                }
            }
        });
        fabricCanvas.on('object:modified', () => saveHistory());

        fabricCanvas.on('selection:created', (_e: any) => {
            if (activeToolRef.current === 'zoom') {
                fabricCanvas.discardActiveObject();
                fabricCanvas.requestRenderAll();
            }
        });
        fabricCanvas.on('selection:updated', (_e: any) => {
            if (activeToolRef.current === 'zoom') {
                fabricCanvas.discardActiveObject();
                fabricCanvas.requestRenderAll();
            }
        });

        // 2. Sockets - Smart URL detection
        // If accessing from localhost, use local server. Otherwise use tunnel/production URL.
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

        // Use the Render URL as the absolute fallback for non-localhost environments
        const productionSocketUrl = 'https://lobos-board-server.onrender.com';
        const socketUrl = isLocalhost
            ? 'http://127.0.0.1:3003'
            : (import.meta.env.VITE_SOCKET_URL || productionSocketUrl);

        console.log(`DEBUG: Connecting to Socket.IO at: ${socketUrl} (isLocalhost: ${isLocalhost})`);
        const socket = io(socketUrl, {
            transports: ['polling', 'websocket'], // Try polling first for better compatibility
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000
        });
        socketRef.current = socket;

        socket.on('connect', () => {
            console.log('CONNECTED to Socket.IO:', socket.id);
            setIsConnected(true);
            socket.emit('join-room', roomId);
        });

        socket.on('disconnect', () => {
            console.log('DISCONNECTED from Socket.IO');
            setIsConnected(false);
        });

        socket.on('connect_error', (error) => {
            console.error('SOCKET CONNECTION ERROR:', error);
            setIsConnected(false);
        });

        // Room State Synchronization
        socket.on('request-sync', (data: { requesterId: string }) => {
            // Only the "teacher" (non-readonly or someone already there) should respond
            // Simplification: everyone responds, the first one to arrive at the student wins
            if (!isReadOnly && fabricCanvas) {
                console.log('Sync requested by:', data.requesterId);
                const state = fabricCanvas.toJSON();
                socket.emit('sync-state', { room: roomId, state, targetId: data.requesterId });
            }
        });

        socket.on('load-state', (state: any) => {
            if (fabricCanvas) {
                console.log('Loading existing room state...');
                isRestoringRef.current = true;
                fabricCanvas.loadFromJSON(state, () => {
                    // Force read-only settings on loaded objects
                    fabricCanvas.getObjects().forEach((obj: any) => {
                        obj.set({
                            selectable: false,
                            evented: !isReadOnly || activeToolRef.current === 'zoom',
                            lockMovementX: true,
                            lockMovementY: true
                        });
                    });
                    fabricCanvas.requestRenderAll();
                    isRestoringRef.current = false;
                    console.log('Room state loaded and locked for student.');
                });
            }
        });

        socket.on('canvas-event', (event: any) => {
            const util = getConstructor('util');
            if (event.type === 'object:added' && util) {
                util.enlivenObjects([event.data], (objects: any[]) => {
                    objects.forEach((obj: any) => {
                        obj.id = event.id;
                        obj.set('remote', true);
                        fabricCanvas.add(obj);
                    });
                    fabricCanvas.renderAll();
                });
            } else if (event.type === 'object:removed') {
                const objects = fabricCanvas.getObjects();
                const toRemove = objects.filter((obj: any) => obj.id === event.id);
                fabricCanvas.remove(...toRemove);
                fabricCanvas.renderAll();
            } else if (event.type === 'clear') {
                fabricCanvas.clear();
            }
        });

        // 3. Eraser and Path logic
        fabricCanvas.on('path:created', (e: any) => {
            const path = e.path;
            path.id = Math.random().toString(36).substr(2, 9);

            if (activeToolRef.current === 'eraser') {
                path.set({
                    fill: 'transparent',
                    globalCompositeOperation: 'destination-out',
                    objectCaching: false,
                    strokeLineCap: 'round',
                    strokeLineJoin: 'round'
                });

                if ((path.width || 0) < 5 && (path.height || 0) < 5) {
                    console.log("DEBUG: Removing too-small eraser path");
                    fabricCanvas.remove(path);
                    return;
                }
            }

            socket.emit('canvas-event', {
                room: roomId,
                type: 'object:added',
                id: path.id,
                data: path.toJSON(['id', 'globalCompositeOperation', 'objectCaching'])
            });
        });

        fabricCanvas.on('mouse:down', (opt: any) => {
            if (activeToolRef.current === 'eraser') {
                isEraserDraggingRef.current = true;
                // Find target precisely even if isDrawingMode is on
                const point = opt.scenePoint || fabricCanvas.getPointer(opt.e);
                const objects = fabricCanvas.getObjects();
                let target = opt.target;

                // Manual hit detection fallback
                if (!target) {
                    for (let i = objects.length - 1; i >= 0; i--) {
                        if (objects[i].containsPoint(point)) {
                            target = objects[i];
                            break;
                        }
                    }
                }

                if (target && target.id && !target.isRipple && (target as any).globalCompositeOperation !== 'destination-out') {
                    socket.emit('canvas-event', { room: roomId, type: 'object:removed', id: target.id });
                    fabricCanvas.remove(target);
                    saveHistory();
                    fabricCanvas.requestRenderAll();
                }
            }
        });

        fabricCanvas.on('mouse:up', () => {
            isEraserDraggingRef.current = false;
        });

        const handleScrubberMove = (e: MouseEvent) => {
            if (activeToolRef.current === 'eraser') {
                // Secondary check: if mouse is down but ref is false, sync them
                if (e.buttons === 1 && !isEraserDraggingRef.current) isEraserDraggingRef.current = true;
                if (e.buttons === 0 && isEraserDraggingRef.current) isEraserDraggingRef.current = false;

                if (isEraserDraggingRef.current) {
                    const pointer = fabricCanvas.getPointer(e);
                    const objects = fabricCanvas.getObjects();

                    // Iterative hit detection (Top-down)
                    for (let i = objects.length - 1; i >= 0; i--) {
                        const obj = objects[i];
                        if (obj.id && !obj.isRipple && (obj as any).globalCompositeOperation !== 'destination-out') {
                            if (obj.containsPoint(pointer)) {
                                socket.emit('canvas-event', { room: roomId, type: 'object:removed', id: obj.id });
                                fabricCanvas.remove(obj);
                                fabricCanvas.requestRenderAll();
                                // Keep going to catch overlapping objects
                            }
                        }
                    }
                }
            }
        };

        window.addEventListener('mousemove', handleScrubberMove);

        return () => {
            console.log("DEBUG: Cleaning up whiteboard effects");
            window.removeEventListener('mousemove', handleScrubberMove);
            fabricCanvas.off('object:added');
            fabricCanvas.off('object:removed');
            fabricCanvas.off('object:modified');
            fabricCanvas.off('selection:created');
            fabricCanvas.off('selection:updated');
            fabricCanvas.off('path:created');
            fabricCanvas.off('mouse:down');
            fabricCanvas.off('mouse:up');
            socket.disconnect();
            if ((fabricCanvas as any)._resizeHandler) {
                window.removeEventListener('resize', (fabricCanvas as any)._resizeHandler);
            }
        };
    }, [canvas, getConstructor, saveHistory, roomId, isReadOnly]);

    // Update tools and current selection properties
    useEffect(() => {
        const c = canvasRef.current;
        if (!c) return;

        const activeObject = c.getActiveObject();
        console.log("DEBUG: Prop update - Tool:", activeTool, "Color:", color, "Size:", size);

        // Friction-less tool switching: Clear selection if tool is not for selecting/edting
        if (!['select', 'text'].includes(activeTool) && activeObject) {
            console.log("DEBUG: Clearing selection for tool:", activeTool);
            c.discardActiveObject();
            c.requestRenderAll();
        }

        // Tool Mode
        c.isDrawingMode = !isReadOnly && (activeTool === 'pen' || activeTool === 'eraser');
        c.selection = !isReadOnly && activeTool === 'select';
        c.skipTargetFind = isReadOnly;

        // Apply read-only lock to all existing objects
        c.getObjects().forEach((obj: any) => {
            obj.set({
                selectable: !isReadOnly && activeTool === 'select',
                evented: !isReadOnly || activeTool === 'zoom',
                lockMovementX: isReadOnly,
                lockMovementY: isReadOnly,
                lockRotation: isReadOnly,
                lockScalingX: isReadOnly,
                lockScalingY: isReadOnly
            });
        });
        c.requestRenderAll();

        if (activeTool === 'eraser') {
            // Selections cleared above globally for tools

            // Try to use dedicated EraserBrush if available in this build
            let BrushConstructor = getConstructor('EraserBrush');
            if (!BrushConstructor) {
                // Fallback to PencilBrush with destination-out
                BrushConstructor = getConstructor('PencilBrush');
            }

            if (BrushConstructor) {
                const eraserBrush = new BrushConstructor(c);
                eraserBrush.width = size * 5;
                // MUST be opaque for destination-out to erase effectively
                eraserBrush.color = '#ffffff';
                // This makes the brush actually erase instead of draw
                (eraserBrush as any).globalCompositeOperation = 'destination-out';
                c.freeDrawingBrush = eraserBrush;

                // UX: Disable selection and caching to ensure erasing is visible
                c.selection = false;
                c.forEachObject((obj: any) => {
                    obj.selectable = false;
                    obj.evented = true; // Allow clicking for object-level erase
                    obj.objectCaching = false;
                });

                // PREMIUM: High-contrast circular cursor that matches eraser size
                const cursorSize = Math.max(size * 5, 12);
                const halfSize = cursorSize / 2;
                const cursorSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cursorSize}" height="${cursorSize}" viewBox="0 0 ${cursorSize} ${cursorSize}">
                    <circle cx="${halfSize}" cy="${halfSize}" r="${halfSize - 1}" fill="rgba(255,255,255,0.15)" stroke="white" stroke-width="1.5"/>
                    <circle cx="${halfSize}" cy="${halfSize}" r="${halfSize - 1}" fill="none" stroke="black" stroke-width="0.5" stroke-dasharray="2,2"/>
                </svg>`;
                const cursorUrl = `url('data:image/svg+xml;base64,${btoa(cursorSvg)}') ${halfSize} ${halfSize}, auto`;

                c.defaultCursor = cursorUrl;
                c.hoverCursor = cursorUrl;
                console.log('DEBUG: Eraser mode active with premium cursor');
            }
        } else if (activeTool === 'pen') {
            // Use normal pencil brush for drawing
            const BrushConstructor = getConstructor('PencilBrush');
            if (BrushConstructor) {
                const brush = new BrushConstructor(c);
                brush.width = size;
                brush.color = color;
                // In Fabric v7, strokeDashArray is supported on PencilBrush
                brush.strokeDashArray = isDashed ? [12, 12] : null;
                // Reset to normal drawing mode
                (brush as any).globalCompositeOperation = 'source-over';
                c.freeDrawingBrush = brush;
            }
        }

        // Hard lock selection for Zoom tool
        c.selection = !isReadOnly && activeTool === 'select';
        c.skipTargetFind = activeTool === 'zoom';

        // Reset eraser-specific overrides if switching away
        if (activeTool !== 'eraser') {
            c.defaultCursor = 'default';
            c.hoverCursor = null;
            c.forEachObject((obj: any) => {
                if (activeObject?.id !== obj.id) {
                    if (activeTool !== 'zoom') {
                        obj.selectable = !isReadOnly && (activeTool === 'select' || activeTool === 'text');
                        obj.evented = true;
                    }
                    if (obj.globalCompositeOperation !== 'destination-out') {
                        obj.objectCaching = true;
                    }
                }
            });
        }

        if (activeTool === 'zoom') {
            c.discardActiveObject();
        }

        if (activeObject && !isReadOnly && (activeTool === 'select' || activeTool === 'text')) {
            let changed = false;
            if (activeObject.type === 'path' || activeObject.type === 'line') {
                const dashArray = isDashed ? [12, 12] : null;
                if (activeObject.stroke !== color || activeObject.strokeWidth !== size || activeObject.strokeDashArray !== dashArray) {
                    activeObject.set({ stroke: color, strokeWidth: size, strokeDashArray: dashArray });
                    changed = true;
                }
            } else if (activeObject.type === 'i-text' && (activeObject as any).isEditing) {
                // If text is being edited, only change styles of the selection
                const textObj = activeObject as any;
                const styles: any = { fill: color, fontSize, fontFamily, fontWeight, underline };
                textObj.setSelectionStyles(styles);
                changed = true;
            } else if (activeObject.type === 'i-text') {
                // Global change for i-text: update object properties AND clear character-level styles
                const textObj = activeObject as any;
                const hasStyleOverride = Object.keys(textObj.styles).length > 0;

                if (textObj.fill !== color || textObj.fontSize !== fontSize ||
                    textObj.fontFamily !== fontFamily || textObj.fontWeight !== fontWeight ||
                    textObj.underline !== underline || hasStyleOverride) {

                    textObj.set({ fill: color, fontSize, fontFamily, fontWeight, underline });

                    // Clear character-level styles to allow global styles to take effect
                    if (textObj.styles) {
                        for (let line in textObj.styles) {
                            for (let char in textObj.styles[line]) {
                                delete textObj.styles[line][char].fill;
                                delete textObj.styles[line][char].fontSize;
                                delete textObj.styles[line][char].fontFamily;
                                delete textObj.styles[line][char].fontWeight;
                                delete textObj.styles[line][char].underline;
                            }
                        }
                    }
                    changed = true;
                }
            } else if (activeObject.type === 'group') {
                // Handle Arrow groups
                const group = activeObject as any;
                const dashArray = isDashed ? [12, 12] : null;
                group.forEachObject((obj: any, index: number) => {
                    // For our arrows: index 0 is shaft, index 1 is head
                    const targetDash = (index === 0) ? dashArray : null;
                    if (obj.stroke !== color || obj.strokeWidth !== size || obj.strokeDashArray !== targetDash) {
                        obj.set({ stroke: color, strokeWidth: size, strokeDashArray: targetDash });
                        changed = true;
                    }
                });
            } else if (['rect', 'circle', 'triangle'].includes(activeObject.type)) {
                const dashArray = isDashed ? [12, 12] : null;
                if (activeObject.fill !== color || activeObject.strokeDashArray !== dashArray) {
                    activeObject.set({ fill: color, strokeDashArray: dashArray });
                    changed = true;
                }
            }

            if (changed) {
                c.renderAll();
                saveHistory();
                console.log("DEBUG: Programmatic change saved to history");
            }
        }

        // --- GLOBAL TOOL STATE ENFORCEMENT ---
        const currentT = activeToolRef.current;

        // Force selection property based on actual current tool
        c.selection = !isReadOnly && currentT === 'select';
        c.skipTargetFind = currentT === 'zoom';

        if (currentT === 'zoom') {
            c.discardActiveObject();
        }

        c.forEachObject((obj: any) => {
            if (currentT === 'zoom') {
                obj.selectable = false;
                obj.evented = false;
            } else {
                obj.selectable = !isReadOnly && (currentT === 'select' || currentT === 'text');
                obj.evented = !isReadOnly;
            }

            // CRITICAL: Disable caching for ALL objects when eraser is active 
            // to ensure destination-out transparency is immediate and visible
            if (currentT === 'eraser') {
                obj.objectCaching = false;
            } else if (obj.globalCompositeOperation !== 'destination-out') {
                // Only re-enable if it's not a cutout path
                obj.objectCaching = true;
            }
        });

        c.calcOffset();
        c.renderAll();
    }, [canvas, activeTool, color, size, fontSize, fontFamily, fontWeight, underline, isReadOnly, isDashed, getConstructor, saveHistory]);


    // Handle text tool clicks - separate effect to avoid closure issues
    useEffect(() => {
        const c = canvasRef.current;
        if (!c) return;

        let lastTextClickTime = 0;

        const handleTextClick = (e: any) => {
            if (activeTool === 'text' && !isReadOnly) {
                const now = Date.now();
                const timeDiff = now - lastTextClickTime;
                lastTextClickTime = now;

                // Only create text on double click (less than 300ms between clicks)
                if (timeDiff > 300 || timeDiff === 0) {
                    console.log('DEBUG: Single click detected, waiting for double click...');
                    return;
                }

                // If an object was clicked, don't create a new text box
                if (e.target) {
                    console.log('DEBUG: Clicked on existing object, skipping text creation');
                    return;
                }

                // Get click coordinates manually from native event
                const nativeEvent = e.e;
                if (!nativeEvent) {
                    console.error('DEBUG: No native event available');
                    return;
                }
                // Get click coordinates safely for Fabric v7
                const pointer = e.scenePoint || (c.getPointer ? c.getPointer(e.e) : {
                    x: e.e.clientX - c.getElement().getBoundingClientRect().left,
                    y: e.e.clientY - c.getElement().getBoundingClientRect().top
                });

                console.log('DEBUG: Creating text at:', pointer.x, pointer.y);

                const Text = getConstructor('IText');
                if (!Text) {
                    console.error('DEBUG: IText constructor not available');
                    return;
                }

                const textId = Math.random().toString(36).substr(2, 9);

                const text = new Text('Escribe aquí...', {
                    left: pointer.x,
                    top: pointer.y,
                    fontSize: fontSize,
                    fontFamily: fontFamily,
                    fontWeight: fontWeight,
                    underline: underline,
                    fill: color,
                    id: textId,
                    selectable: true,
                    evented: true,
                    editable: true,
                    // Style selection border
                    borderColor: '#6366f1',
                    borderScaleFactor: 2.5,
                    borderOpacityWhenMoving: 1,
                    cornerColor: '#6366f1',
                    cornerSize: 10,
                    transparentCorners: false,
                    selectionBackgroundColor: 'rgba(99, 102, 241, 0.1)' // Very subtle background
                });

                // Hide side handles, keep only corner ones for diagonal resizing
                text.setControlsVisibility({
                    mt: false, mb: false, ml: false, mr: false,
                    tl: true, tr: true, bl: true, br: true,
                    mtr: true // keep rotation handle
                });

                c.add(text);
                c.setActiveObject(text);

                // Enter editing mode automatically
                text.enterEditing();
                text.selectAll();

                c.renderAll();

                socketRef.current?.emit('canvas-event', {
                    room: roomId,
                    type: 'object:added',
                    id: textId,
                    data: text.toJSON(['id', 'globalCompositeOperation', 'objectCaching'])
                });

                saveHistory();
                console.log('DEBUG: Text created successfully');
            }
        };

        c.on('mouse:down', handleTextClick);

        return () => {
            c.off('mouse:down', handleTextClick);
        };
    }, [canvas, activeTool, isReadOnly, color, fontSize, fontFamily, fontWeight, underline, getConstructor, saveHistory]);

    // Reset zoom and pan
    // Reset zoom and pan with precision tolerance and synchronized matrix interpolation
    const resetZoom = useCallback(() => {
        const c = canvasRef.current;
        if (!c) return;

        console.log("DEBUG: Reset Zoom triggered");

        const startVpt = c.viewportTransform ? [...c.viewportTransform] : [1, 0, 0, 1, 0, 0];
        const targetVpt = [1, 0, 0, 1, 0, 0];

        const util = (fabric as any).util || getConstructor('util');

        // Use a small epsilon for floating point comparison
        const isAlreadyReset = startVpt.every((val, i) => Math.abs(val - targetVpt[i]) < 0.0001);

        if (util && util.animate && !isAlreadyReset) {
            console.log("DEBUG: Animating reset from", startVpt);

            // Easing fallback
            const easingFunc = (util.ease && util.ease.easeOutQuart)
                ? util.ease.easeOutQuart
                : (t: number) => t;

            util.animate({
                startValue: 0,
                endValue: 1,
                duration: 450,
                onChange: (t: number) => {
                    // Interpolate the entire transformation matrix
                    const currentVpt = startVpt.map((start, i) => start + (targetVpt[i] - start) * t);
                    c.setViewportTransform(currentVpt);

                    // Keep UI scale state in sync
                    setZoom(currentVpt[0]);
                    c.renderAll();
                },
                onComplete: () => {
                    c.setViewportTransform(targetVpt);
                    setZoom(1);
                    c.renderAll();
                    console.log("DEBUG: Reset Animation Complete");
                },
                easing: easingFunc
            });
        } else {
            console.log("DEBUG: Direct reset (no animation needed or util missing)");
            c.setViewportTransform(targetVpt);
            setZoom(1);
            c.renderAll();
        }
    }, [getConstructor]);

    // Helper for smooth animated zoom
    const animateZoom = useCallback((targetViewportPoint: { x: number, y: number }, endZoom: number) => {
        const c = canvasRef.current;
        if (!c) return;

        const startZoom = c.getZoom();
        const util = getConstructor('util') || (fabric as any).util;

        if (util && util.animate) {
            util.animate({
                startValue: startZoom,
                endValue: endZoom,
                duration: 350,
                onChange: (value: number) => {
                    c.zoomToPoint(targetViewportPoint, value);
                    setZoom(value);
                    c.renderAll();
                },
                easing: util.ease.easeOutQuart
            });
        } else {
            c.zoomToPoint(targetViewportPoint, endZoom);
            setZoom(endZoom);
            c.renderAll();
        }
    }, [getConstructor]);

    // Visual feedback ripple effect
    const showRipple = useCallback((scenePoint: { x: number, y: number }) => {
        const c = canvasRef.current;
        const Circle = getConstructor('Circle');
        const util = getConstructor('util') || (fabric as any).util;
        if (!c || !Circle || !util) return;

        const ripple = new Circle({
            left: scenePoint.x,
            top: scenePoint.y,
            radius: 2,
            fill: 'transparent',
            stroke: color,
            strokeWidth: 4,
            originX: 'center',
            originY: 'center',
            selectable: false,
            evented: false,
            opacity: 0.8
        });

        c.add(ripple);

        util.animate({
            startValue: 2,
            endValue: 60,
            duration: 500,
            onChange: (value: number) => {
                ripple.set({
                    radius: value,
                    opacity: 0.8 * (1 - value / 60),
                    strokeWidth: 4 * (1 - value / 60)
                });
                c.renderAll();
            },
            onComplete: () => {
                c.remove(ripple);
                c.renderAll();
            }
        });
    }, [color, getConstructor]);

    // Centralized Zoom In/Out functions
    const zoomIn = useCallback(() => {
        const c = canvasRef.current;
        if (!c) return;
        let currentZoom = c.getZoom();
        let newZoom = currentZoom * 1.5; // Bigger step for manual buttons
        if (newZoom > 20) newZoom = 20;

        const center = c.getVpCenter();
        animateZoom({ x: center.x, y: center.y }, newZoom);
    }, [animateZoom]);

    const zoomOut = useCallback(() => {
        const c = canvasRef.current;
        if (!c) return;
        let currentZoom = c.getZoom();
        let newZoom = currentZoom / 1.5;
        if (newZoom < 0.01) newZoom = 0.01;

        const center = c.getVpCenter();
        animateZoom({ x: center.x, y: center.y }, newZoom);
    }, [animateZoom]);

    // Handle interactive arrow drawing and Zoom/Pan listeners
    useEffect(() => {
        const c = canvasRef.current;
        if (!c || isReadOnly) return;

        // --- ZOOM (WHEEL) ---
        const handleWheel = (opt: any) => {
            const delta = opt.e.deltaY;
            let currentZoom = c.getZoom();
            currentZoom *= 0.999 ** delta;
            if (currentZoom > 20) currentZoom = 20;
            if (currentZoom < 0.01) currentZoom = 0.01;

            c.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, currentZoom);
            opt.e.preventDefault();
            opt.e.stopPropagation();
            setZoom(currentZoom);
        };

        c.on('mouse:wheel', handleWheel);

        // --- NAVIGATION / PANNING ---
        const handleNavMouseDown = (opt: any) => {
            if (activeToolRef.current !== 'zoom' || !c) return;

            // Critical: stop Fabric's internal selection logic
            if (opt.e) {
                opt.e.preventDefault();
                opt.e.stopPropagation();
            }

            isPanningRef.current = true;

            // Hard lock properties just in case
            c.selection = false;
            c.skipTargetFind = true;
            c.isDrawingMode = false;
            c.discardActiveObject();
            c.requestRenderAll();

            // In Fabric v7, scenePoint is often available on the opt object
            const point = opt.scenePoint || (c.getPointer && c.getPointer(opt.e)) || { x: 0, y: 0 };

            lastPanPosRef.current = { x: opt.e.clientX, y: opt.e.clientY }; // Use screen coords for panning delta
            mouseDownPointRef.current = { x: point.x, y: point.y };
            console.log("DEBUG: Zoom Nav Down at", point);
        };

        const handleNavMouseMove = (opt: any) => {
            if (!isPanningRef.current || !lastPanPosRef.current || !c.viewportTransform) return;

            if (activeToolRef.current !== 'zoom') return; // Double check

            if (opt.e) {
                opt.e.preventDefault();
            }

            // Hard lock every move just in case
            c.selection = false;
            c.skipTargetFind = true;

            const e = opt.e;
            const vpt = [...c.viewportTransform];
            vpt[4] += e.clientX - lastPanPosRef.current.x;
            vpt[5] += e.clientY - lastPanPosRef.current.y;
            c.setViewportTransform(vpt);
            c.requestRenderAll();
            lastPanPosRef.current = { x: e.clientX, y: e.clientY };
        };

        const handleNavMouseUp = (opt: any) => {
            if (!isPanningRef.current || !c) return;
            isPanningRef.current = false;

            // Use ref to avoid stale closure
            const currentT = activeToolRef.current;
            c.selection = currentT === 'select';
            c.skipTargetFind = currentT === 'zoom';

            // Check if it was a click (not a drag)
            if (mouseDownPointRef.current) {
                const point = opt.scenePoint || (c.getPointer && c.getPointer(opt.e)) || { x: 0, y: 0 };
                const dx = Math.abs(point.x - mouseDownPointRef.current.x);
                const dy = Math.abs(point.y - mouseDownPointRef.current.y);

                console.log("DEBUG: Zoom Nav Up. delta:", dx, dy);

                if (dx < 10 && dy < 10) {
                    // It's a click! Perform zoom at point
                    let currentZoom = c.getZoom();

                    // Zoom In on Left Click (button 0), Out on Alt+Click or Right Click (button 2)
                    const isZoomOut = opt.e.altKey || opt.e.button === 2;
                    const factor = isZoomOut ? 0.75 : 1.35;

                    let newZoom = currentZoom * factor;
                    if (newZoom > 20) newZoom = 20;
                    if (newZoom < 0.01) newZoom = 0.01;

                    // Use viewport coordinates (relative to canvas element)
                    let targetViewportPoint = { x: opt.e.offsetX, y: opt.e.offsetY };

                    // Hit detection logic (using scene coordinates 'point')
                    const objects = c.getObjects();
                    let foundTarget = null;
                    for (let i = objects.length - 1; i >= 0; i--) {
                        if (objects[i].containsPoint(point)) {
                            foundTarget = objects[i];
                            break;
                        }
                    }

                    if (foundTarget) {
                        const sceneCenter = foundTarget.getCenterPoint();
                        const vpt = c.viewportTransform;
                        if (vpt) {
                            const util = getConstructor('util') || fabric.util;
                            targetViewportPoint = util.transformPoint(sceneCenter, vpt);
                        }

                        // Show visual feedback at the object's scene center
                        showRipple(sceneCenter);
                        console.log("DEBUG: Object-centric animated zoom (viewport):", targetViewportPoint);
                    }

                    console.log("DEBUG: Animated zooming to point", targetViewportPoint, "New Zoom:", newZoom);
                    animateZoom(targetViewportPoint, newZoom);
                }
            }
            mouseDownPointRef.current = null;
        };

        if (activeTool === 'zoom') {
            c.defaultCursor = 'zoom-in';
            c.selection = false;
            c.skipTargetFind = true;
            c.discardActiveObject();

            // Explicitly disable interaction for all objects while zooming/panning
            c.forEachObject((obj: any) => {
                obj.selectable = false;
                obj.evented = false;
            });
            c.renderAll();

            const handleMouseDownInternal = (opt: any) => handleNavMouseDown(opt);
            const handleMouseMoveInternal = (opt: any) => handleNavMouseMove(opt);
            const handleMouseUpInternal = (opt: any) => handleNavMouseUp(opt);

            c.on('mouse:down', handleMouseDownInternal);
            c.on('mouse:move', handleMouseMoveInternal);
            c.on('mouse:up', handleMouseUpInternal);

            const handleKeyDown = (e: KeyboardEvent) => {
                if (e.altKey) c.defaultCursor = 'zoom-out';
                c.renderAll();
            };
            const handleKeyUp = (e: KeyboardEvent) => {
                if (!e.altKey) c.defaultCursor = 'zoom-in';
                c.renderAll();
            };
            window.addEventListener('keydown', handleKeyDown);
            window.addEventListener('keyup', handleKeyUp);

            return () => {
                c.off('mouse:wheel', handleWheel);
                c.off('mouse:down', handleMouseDownInternal);
                c.off('mouse:move', handleMouseMoveInternal);
                c.off('mouse:up', handleMouseUpInternal);
                window.removeEventListener('keydown', handleKeyDown);
                window.removeEventListener('keyup', handleKeyUp);
                c.defaultCursor = 'default';
            };
        }

        return () => {
            c.off('mouse:wheel', handleWheel);
            c.off('mouse:down', handleNavMouseDown);
            c.off('mouse:move', handleNavMouseMove);
            c.off('mouse:up', handleNavMouseUp);
            c.defaultCursor = 'default';
        };
    }, [canvas, activeTool, isReadOnly]);

    // Handle interactive arrow drawing (Original Logic)
    useEffect(() => {
        const c = canvasRef.current;
        if (!c || isReadOnly || activeTool !== 'arrow') return;

        let isDrawing = false;
        let startPoint: { x: number, y: number } | null = null;
        let shaftPath: any = null;
        let headPath: any = null;

        const getArrowPath = (dx: number, dy: number) => {
            const headLength = 22 + (size / 2);
            const angle = Math.atan2(dy, dx);

            // Wings relative to (0, 0) where shaft ends at (dx, dy)
            const x3 = dx - headLength * Math.cos(angle - Math.PI / 6);
            const y3 = dy - headLength * Math.sin(angle - Math.PI / 6);
            const x4 = dx - headLength * Math.cos(angle + Math.PI / 6);
            const y4 = dy - headLength * Math.sin(angle + Math.PI / 6);

            const shaft = `M 0 0 L ${dx} ${dy}`;
            const head = `M ${x3} ${y3} L ${dx} ${dy} L ${x4} ${y4}`;

            // Bounds for the whole arrow
            const minX = Math.min(0, dx, x3, x4);
            const minY = Math.min(0, dy, y3, y4);
            const maxX = Math.max(0, dx, x3, x4);
            const maxY = Math.max(0, dy, y3, y4);

            return {
                shaft,
                head,
                width: Math.max(1, maxX - minX),
                height: Math.max(1, maxY - minY),
                minX,
                minY
            };
        };

        const handleMouseDown = (opt: any) => {
            if (activeTool !== 'arrow') return;
            isDrawing = true;

            // Safe pointer retrieval for Fabric v7
            const pointer = opt.scenePoint || (opt.e ? {
                x: opt.e.clientX - c.getElement().getBoundingClientRect().left,
                y: opt.e.clientY - c.getElement().getBoundingClientRect().top
            } : { x: 0, y: 0 });

            startPoint = { x: pointer.x, y: pointer.y };
            shaftPath = null;
            headPath = null;
        };

        const handleMouseMove = (opt: any) => {
            if (!isDrawing || !startPoint) return;

            // Safe pointer retrieval for Fabric v7
            const pointer = opt.scenePoint || (opt.e ? {
                x: opt.e.clientX - c.getElement().getBoundingClientRect().left,
                y: opt.e.clientY - c.getElement().getBoundingClientRect().top
            } : { x: 0, y: 0 });

            const dx = pointer.x - startPoint.x;
            const dy = pointer.y - startPoint.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            // Only create the arrow parts if the user has dragged at least 5 pixels
            if (!shaftPath && distance > 5) {
                const Path = getConstructor('Path');
                if (Path) {
                    const initial = getArrowPath(dx, dy);

                    // Create dashed shaft
                    shaftPath = new Path(initial.shaft, {
                        stroke: color,
                        strokeWidth: size,
                        fill: 'transparent',
                        strokeLineCap: 'round',
                        strokeLineJoin: 'round',
                        selectable: false,
                        evented: false,
                        strokeDashArray: isDashed ? [12, 12] : null,
                        left: startPoint.x + initial.minX,
                        top: startPoint.y + initial.minY,
                        width: initial.width,
                        height: initial.height,
                        originX: 'left',
                        originY: 'top',
                        pathOffset: { x: initial.minX + initial.width / 2, y: initial.minY + initial.height / 2 },
                        objectCaching: false
                    });

                    // Create solid head
                    headPath = new Path(initial.head, {
                        stroke: color,
                        strokeWidth: size,
                        fill: 'transparent',
                        strokeLineCap: 'round',
                        strokeLineJoin: 'round',
                        selectable: false,
                        evented: false,
                        // Head is NEVER dashed to avoid "dots"
                        left: startPoint.x + initial.minX,
                        top: startPoint.y + initial.minY,
                        width: initial.width,
                        height: initial.height,
                        originX: 'left',
                        originY: 'top',
                        pathOffset: { x: initial.minX + initial.width / 2, y: initial.minY + initial.height / 2 },
                        objectCaching: false
                    });

                    c.add(shaftPath);
                    c.add(headPath);
                }
                return;
            }

            if (!shaftPath || !headPath) return;

            const result = getArrowPath(dx, dy);

            try {
                const util = getConstructor('util') || (fabric as any).util;
                const shaftData = util && util.parsePath ? util.parsePath(result.shaft) : result.shaft;
                const headData = util && util.parsePath ? util.parsePath(result.head) : result.head;

                const commonProps = {
                    left: startPoint.x + result.minX,
                    top: startPoint.y + result.minY,
                    width: result.width,
                    height: result.height,
                    pathOffset: {
                        x: result.minX + result.width / 2,
                        y: result.minY + result.height / 2
                    }
                };

                shaftPath.set({ path: shaftData, ...commonProps });
                headPath.set({ path: headData, ...commonProps });

                shaftPath.setCoords();
                headPath.setCoords();
                c.renderAll();
            } catch (e) {
                console.error('DEBUG: Error updating arrow components:', e);
            }
        };

        const handleMouseUp = () => {
            if (!isDrawing) return;
            isDrawing = false;

            if (shaftPath && headPath) {
                const Group = getConstructor('Group');
                if (Group) {
                    // Remove individual parts
                    c.remove(shaftPath);
                    c.remove(headPath);

                    // Re-enable caching for performance
                    shaftPath.set('objectCaching', true);
                    headPath.set('objectCaching', true);

                    const arrowGroup = new Group([shaftPath, headPath], {
                        selectable: true,
                        evented: true,
                        id: Math.random().toString(36).substr(2, 9)
                    });

                    c.add(arrowGroup);
                    arrowGroup.setCoords();

                    socketRef.current?.emit('canvas-event', {
                        room: roomId,
                        type: 'object:added',
                        id: arrowGroup.get('id'),
                        data: arrowGroup.toJSON(['id'])
                    });

                    saveHistory();
                }
            }

            startPoint = null;
            shaftPath = null;
            headPath = null;
        };

        c.on('mouse:down', handleMouseDown);
        c.on('mouse:move', handleMouseMove);
        c.on('mouse:up', handleMouseUp);

        // Disable selection while drawing
        c.selection = false;

        return () => {
            c.off('mouse:down', handleMouseDown);
            c.off('mouse:move', handleMouseMove);
            c.off('mouse:up', handleMouseUp);
        };
    }, [canvas, activeTool, isReadOnly, color, size, isDashed, getConstructor, saveHistory]);

    const addShape = useCallback((type: string) => {
        const c = canvasRef.current;
        if (!c || isReadOnly) return;

        // Calculate center manually
        const center = {
            left: (c.width || 400) / 2,
            top: (c.height || 400) / 2
        };
        const shapeId = Math.random().toString(36).substr(2, 9);

        // Determine stroke color based on fill color for visibility
        // If fill is white or very light, use a DARK stroke, otherwise use a lighter stroke
        const isLightColor = color === '#ffffff' || color === '#FFFFFF';
        const strokeColor = isLightColor ? '#64748b' : 'rgba(0, 0, 0, 0.4)';
        const strokeWidth = isLightColor ? 3 : 2;

        const commonProps = {
            left: center.left,
            top: center.top,
            fill: color,
            stroke: strokeColor,
            strokeWidth: strokeWidth,
            strokeDashArray: isDashed ? [10, 5] : null,
            originX: 'center',
            originY: 'center',
            id: shapeId,
            selectable: true,
            evented: true
        };

        let shape: any = null;
        if (type === 'square') {
            const Rect = getConstructor('Rect');
            if (Rect) shape = new Rect({ ...commonProps, width: 100, height: 100 });
        } else if (type === 'circle') {
            const Circle = getConstructor('Circle');
            if (Circle) shape = new Circle({ ...commonProps, radius: 50 });
        } else if (type === 'triangle') {
            const Triangle = getConstructor('Triangle');
            if (Triangle) shape = new Triangle({ ...commonProps, width: 100, height: 100 });
        }

        if (shape) {
            // Force canvas into selection mode if appropriate
            c.isDrawingMode = false;
            c.selection = !isReadOnly && activeToolRef.current === 'select';

            // Add shape to canvas
            c.add(shape);

            // Explicitly ensure shape is selectable and evented
            shape.set({
                selectable: true,
                evented: true
            });

            // Set as active object
            c.setActiveObject(shape);
            c.renderAll();

            socketRef.current?.emit('canvas-event', {
                room: roomId,
                type: 'object:added',
                id: shapeId,
                data: shape.toJSON(['id', 'stroke', 'strokeWidth', 'globalCompositeOperation', 'objectCaching'])
            });

            saveHistory();
        }
    }, [isReadOnly, color, getConstructor, saveHistory]);

    const addText = useCallback(() => {
        const c = canvasRef.current;
        if (!c || isReadOnly) return;

        const Text = getConstructor('IText');
        if (!Text) return;

        const center = {
            left: (c.width || 400) / 2,
            top: (c.height || 400) / 2
        };

        const textId = Math.random().toString(36).substr(2, 9);

        const text = new Text('Escribe aquí...', {
            left: center.left,
            top: center.top,
            fontSize: fontSize,
            fontFamily: fontFamily,
            fontWeight: fontWeight,
            underline: underline,
            fill: color,
            originX: 'center',
            originY: 'center',
            id: textId,
            selectable: true,
            evented: true,
            editable: true,
            // Style selection border
            borderColor: '#6366f1',
            borderScaleFactor: 2.5,
            borderOpacityWhenMoving: 1,
            cornerColor: '#6366f1',
            cornerSize: 10,
            transparentCorners: false,
            selectionBackgroundColor: 'rgba(99, 102, 241, 0.1)'
        });

        // Hide side handles, keep only corner ones for diagonal resizing
        text.setControlsVisibility({
            mt: false, mb: false, ml: false, mr: false,
            tl: true, tr: true, bl: true, br: true,
            mtr: true
        });

        c.add(text);
        c.setActiveObject(text);

        // Enter editing mode automatically
        text.enterEditing();
        text.selectAll();

        c.renderAll();

        socketRef.current?.emit('canvas-event', {
            room: roomId,
            type: 'object:added',
            id: textId,
            data: text.toJSON(['id'])
        });

        saveHistory();
    }, [isReadOnly, color, getConstructor, saveHistory]);

    const deleteSelected = useCallback(() => {
        const c = canvasRef.current;
        if (!c || isReadOnly) return;
        const active = c.getActiveObjects();

        if (active.length === 0) return;

        // Check if any active object is a text in editing mode
        const hasEditingText = active.some((obj: any) =>
            obj.type === 'i-text' && obj.isEditing
        );

        // If text is being edited, don't delete the object - let normal text editing happen
        if (hasEditingText) {
            console.log('DEBUG: Text is in editing mode, skipping delete');
            return;
        }

        active.forEach((obj: any) => {
            if (obj.id) {
                socketRef.current?.emit('canvas-event', {
                    room: roomId,
                    type: 'object:removed',
                    id: obj.id
                });
            }
            c.remove(obj);
        });

        c.discardActiveObject();
        c.renderAll();
        saveHistory();
    }, [isReadOnly, saveHistory]);

    const undo = useCallback(async () => {
        const c = canvasRef.current;
        if (!c || historyRef.current.undo.length <= 1) {
            console.log("DEBUG: Nothing to undo", historyRef.current.undo.length);
            return;
        }

        console.log("DEBUG: Starting Undo...");
        isRestoringRef.current = true;
        const currentState = historyRef.current.undo.pop();
        if (currentState) {
            historyRef.current.redo.push(currentState);
        }

        const prevState = historyRef.current.undo[historyRef.current.undo.length - 1];
        try {
            await c.loadFromJSON(prevState);
            console.log("DEBUG: Undo loaded JSON");
            c.renderAll();
            // Small delay to let any trailing events finish before allowing history saves again
            setTimeout(() => {
                isRestoringRef.current = false;
                console.log("DEBUG: Undo complete. Redo stack:", historyRef.current.redo.length);
            }, 50);
        } catch (error) {
            console.error("DEBUG: Undo error:", error);
            isRestoringRef.current = false;
        }
    }, []);

    const redo = useCallback(async () => {
        const c = canvasRef.current;
        if (!c || historyRef.current.redo.length === 0) {
            console.log("DEBUG: Nothing to redo", historyRef.current.redo.length);
            return;
        }

        console.log("DEBUG: Starting Redo...");
        isRestoringRef.current = true;
        const nextState = historyRef.current.redo.pop();
        if (nextState) {
            historyRef.current.undo.push(nextState);
            try {
                await c.loadFromJSON(nextState);
                console.log("DEBUG: Redo loaded JSON");
                c.renderAll();
                setTimeout(() => {
                    isRestoringRef.current = false;
                    console.log("DEBUG: Redo complete. Undo stack:", historyRef.current.undo.length);
                }, 50);
            } catch (error) {
                console.error("DEBUG: Redo error:", error);
                isRestoringRef.current = false;
            }
        }
    }, []);

    const copy = useCallback(async () => {
        const c = canvasRef.current;
        if (!c) return;
        const active = c.getActiveObject();
        if (active) {
            try {
                const cloned = await active.clone(['id', 'globalCompositeOperation', 'objectCaching']);
                clipboardRef.current = cloned;
                console.log("DEBUG: Object copied:", active.type);
            } catch (error) {
                console.error("DEBUG: Copy error:", error);
            }
        } else {
            console.log("DEBUG: No active object to copy");
        }
    }, []);

    const paste = useCallback(async () => {
        const c = canvasRef.current;
        if (!c || !clipboardRef.current) {
            console.log("DEBUG: Paste failed - no clipboard or canvas");
            return;
        }

        try {
            const clonedObj = await clipboardRef.current.clone(['id', 'globalCompositeOperation', 'objectCaching']);
            c.discardActiveObject();
            clonedObj.set({
                left: clonedObj.left + 20,
                top: clonedObj.top + 20,
                evented: true,
                selectable: true,
                id: Math.random().toString(36).substr(2, 9)
            });

            if (clonedObj.type === 'activeSelection') {
                clonedObj.canvas = c;
                clonedObj.forEachObject((obj: any) => {
                    obj.id = Math.random().toString(36).substr(2, 9);
                    obj.selectable = true;
                    obj.evented = true;
                    c.add(obj);
                });
                clonedObj.setCoords();
            } else {
                c.add(clonedObj);
            }

            c.setActiveObject(clonedObj);
            c.renderAll();

            socketRef.current?.emit('canvas-event', {
                room: roomId,
                type: 'object:added',
                id: clonedObj.id,
                data: clonedObj.toJSON(['id', 'globalCompositeOperation', 'objectCaching'])
            });

            saveHistory();
            console.log("DEBUG: Object pasted:", clonedObj.type);
        } catch (error) {
            console.error("DEBUG: Paste error:", error);
        }
    }, [saveHistory]);

    const cut = useCallback(async () => {
        const c = canvasRef.current;
        if (!c || isReadOnly) return;
        const active = c.getActiveObject();
        if (active) {
            try {
                const cloned = await active.clone(['id', 'globalCompositeOperation', 'objectCaching']);
                clipboardRef.current = cloned;
                const activeObjects = c.getActiveObjects();
                activeObjects.forEach((obj: any) => {
                    if (obj.id) {
                        socketRef.current?.emit('canvas-event', {
                            room: roomId,
                            type: 'object:removed',
                            id: obj.id
                        });
                    }
                    c.remove(obj);
                });
                c.discardActiveObject();
                c.renderAll();
                saveHistory();
                console.log("DEBUG: Object cut:", active.type);
            } catch (error) {
                console.error("DEBUG: Cut error:", error);
            }
        }
    }, [isReadOnly, saveHistory]);

    const duplicate = useCallback(async () => {
        const c = canvasRef.current;
        if (!c || isReadOnly) return;
        const active = c.getActiveObject();
        if (active) {
            try {
                const cloned = await active.clone(['id', 'globalCompositeOperation', 'objectCaching']);
                cloned.set({
                    left: cloned.left + 15,
                    top: cloned.top + 15,
                    evented: true,
                    selectable: true,
                    id: Math.random().toString(36).substr(2, 9)
                });

                if (cloned.type === 'activeSelection') {
                    cloned.canvas = c;
                    cloned.forEachObject((obj: any) => {
                        obj.id = Math.random().toString(36).substr(2, 9);
                        obj.selectable = true;
                        obj.evented = true;
                        c.add(obj);
                    });
                    cloned.setCoords();
                } else {
                    c.add(cloned);
                }

                c.setActiveObject(cloned);
                c.renderAll();

                socketRef.current?.emit('canvas-event', {
                    room: roomId,
                    type: 'object:added',
                    id: cloned.id,
                    data: cloned.toJSON(['id', 'globalCompositeOperation', 'objectCaching'])
                });

                saveHistory();
                console.log("DEBUG: Object duplicated:", cloned.type);
            } catch (error) {
                console.error("DEBUG: Duplicate error:", error);
            }
        } else {
            console.log("DEBUG: No object selected to duplicate");
        }
    }, [isReadOnly, saveHistory]);

    const resetWhiteboard = useCallback(() => {
        const c = canvasRef.current;
        if (!c || isReadOnly) return;

        console.log("DEBUG: Performing Hard Reset");

        // 1. Clear Canvas
        c.clear();

        // 2. Clear History
        const initialJson = JSON.stringify(c.toJSON(['id', 'globalCompositeOperation', 'objectCaching']));
        historyRef.current = { undo: [initialJson], redo: [] };

        // 3. Clear Clipboard
        clipboardRef.current = null;

        // 4. Sync
        socketRef.current?.emit('canvas-event', { room: roomId, type: 'clear' });

        c.renderAll();
        console.log("DEBUG: Hard Reset complete");
    }, [isReadOnly]);

    const uploadImage = useCallback((file: File) => {
        const c = canvasRef.current;
        if (!c || isReadOnly) return;

        const fileType = file.type;
        console.log('DEBUG: Uploading file type:', fileType);

        // Handle PDFs
        if (fileType === 'application/pdf') {
            console.log('DEBUG: Starting PDF processing...');
            const reader = new FileReader();
            reader.onload = async (e) => {
                console.log('DEBUG: FileReader loaded, starting async processing');
                try {
                    const pdfData = e.target?.result as ArrayBuffer;
                    console.log('DEBUG: PDF data loaded, size:', pdfData.byteLength);

                    console.log('DEBUG: Importing pdfjs-dist...');
                    const pdfjsLib = await import('pdfjs-dist');
                    console.log('DEBUG: pdfjs-dist imported successfully');

                    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
                        'pdfjs-dist/build/pdf.worker.min.mjs',
                        import.meta.url
                    ).toString();
                    console.log('DEBUG: Worker configured');

                    console.log('DEBUG: Loading PDF document...');
                    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
                    console.log('DEBUG: PDF loaded, pages:', pdf.numPages);

                    console.log('DEBUG: Getting first page...');
                    const page = await pdf.getPage(1);
                    console.log('DEBUG: Page loaded');

                    const viewport = page.getViewport({ scale: 1.5 });
                    console.log('DEBUG: Viewport created:', viewport.width, 'x', viewport.height);

                    const tempCanvas = document.createElement('canvas');
                    const context = tempCanvas.getContext('2d');

                    if (!context) {
                        console.error('DEBUG: Failed to get 2d context');
                        return;
                    }

                    tempCanvas.width = viewport.width;
                    tempCanvas.height = viewport.height;
                    console.log('DEBUG: Canvas created, rendering...');

                    await page.render({
                        canvasContext: context,
                        viewport: viewport
                    }).promise;
                    console.log('DEBUG: Page rendered to canvas');

                    const imgData = tempCanvas.toDataURL('image/png');
                    console.log('DEBUG: Image data URL created, length:', imgData.length);

                    const ImageConstructor = getConstructor('Image');
                    if (!ImageConstructor) {
                        console.error('DEBUG: Image constructor not found!');
                        return;
                    }
                    console.log('DEBUG: Image constructor obtained, creating image...');

                    const img = await ImageConstructor.fromURL(imgData);
                    console.log('DEBUG: Image loaded from URL, dimensions:', img.width, 'x', img.height);

                    const maxWidth = 800;
                    const maxHeight = 600;

                    if (img.width > maxWidth || img.height > maxHeight) {
                        const scale = Math.min(maxWidth / img.width, maxHeight / img.height);
                        img.scale(scale);
                        console.log('DEBUG: Image scaled by:', scale);
                    }

                    const center = { left: (c.width || 400) / 2, top: (c.height || 400) / 2 };
                    img.set({
                        left: center.left,
                        top: center.top,
                        originX: 'center',
                        originY: 'center',
                        id: Math.random().toString(36).substr(2, 9),
                        selectable: true,
                        evented: true
                    });
                    console.log('DEBUG: Image positioned and configured');

                    c.add(img);
                    c.setActiveObject(img);
                    c.renderAll();
                    console.log('DEBUG: Image added to canvas');

                    socketRef.current?.emit('canvas-event', {
                        room: roomId,
                        type: 'object:added',
                        id: img.id,
                        data: img.toJSON(['id', 'globalCompositeOperation', 'objectCaching'])
                    });

                    saveHistory();
                    console.log("DEBUG: PDF uploaded successfully!");
                } catch (error) {
                    console.error("DEBUG: Error loading PDF:", error);
                }
            };
            console.log('DEBUG: Starting to read file as ArrayBuffer...');
            reader.readAsArrayBuffer(file);
        }
        // Handle Videos
        else if (fileType.startsWith('video/')) {
            const videoUrl = URL.createObjectURL(file);
            const videoEl = document.createElement('video');
            videoEl.src = videoUrl;
            videoEl.crossOrigin = 'anonymous';
            videoEl.muted = false; // Audio enabled
            videoEl.loop = false; // No auto loop

            videoEl.addEventListener('loadeddata', async () => {
                try {
                    const tempCanvas = document.createElement('canvas');
                    tempCanvas.width = videoEl.videoWidth;
                    tempCanvas.height = videoEl.videoHeight;
                    const ctx = tempCanvas.getContext('2d');

                    if (!ctx) return;

                    // Draw first frame
                    ctx.drawImage(videoEl, 0, 0);
                    const thumbnailData = tempCanvas.toDataURL();

                    const ImageConstructor = getConstructor('Image');
                    if (!ImageConstructor) return;

                    const img = await ImageConstructor.fromURL(thumbnailData);

                    const maxWidth = 800;
                    const maxHeight = 600;

                    if (img.width > maxWidth || img.height > maxHeight) {
                        const scale = Math.min(maxWidth / img.width, maxHeight / img.height);
                        img.scale(scale);
                    }

                    const center = { left: (c.width || 400) / 2, top: (c.height || 400) / 2 };
                    img.set({
                        left: center.left,
                        top: center.top,
                        originX: 'center',
                        originY: 'center',
                        id: Math.random().toString(36).substr(2, 9),
                        selectable: true,
                        evented: true
                    });

                    // Store video element and controls reference
                    (img as any).videoElement = videoEl;
                    (img as any).isVideo = true;
                    (img as any).isPlaying = false;
                    (img as any).animationFrameId = null;

                    // Function to render video frames in real-time
                    const renderVideoFrame = () => {
                        if ((img as any).isPlaying && !videoEl.paused && !videoEl.ended) {
                            const canvas = document.createElement('canvas');
                            canvas.width = videoEl.videoWidth;
                            canvas.height = videoEl.videoHeight;
                            const context = canvas.getContext('2d');

                            if (context) {
                                context.drawImage(videoEl, 0, 0);
                                const frameData = canvas.toDataURL();

                                // Update Fabric.js image with new frame
                                const imgEl = new Image();
                                imgEl.onload = () => {
                                    img.setElement(imgEl);
                                    c.renderAll();
                                };
                                imgEl.src = frameData;
                            }

                            // Continue rendering
                            (img as any).animationFrameId = requestAnimationFrame(renderVideoFrame);
                        }
                    };

                    // Simplified control - click on video to toggle Play/Pause
                    img.on('mousedown', () => {
                        if (videoEl.paused) {
                            videoEl.play();
                            (img as any).isPlaying = true;
                            renderVideoFrame();
                            console.log('DEBUG: Playing video');
                        } else {
                            videoEl.pause();
                            (img as any).isPlaying = false;
                            if ((img as any).animationFrameId) {
                                cancelAnimationFrame((img as any).animationFrameId);
                            }
                            console.log('DEBUG: Pausing video');
                        }
                    });

                    c.add(img);
                    c.setActiveObject(img);
                    c.renderAll();

                    socketRef.current?.emit('canvas-event', {
                        room: roomId,
                        type: 'object:added',
                        id: img.id,
                        data: img.toJSON(['id', 'globalCompositeOperation', 'objectCaching'])
                    });

                    saveHistory();
                    console.log("DEBUG: Video uploaded successfully");
                } catch (error) {
                    console.error("DEBUG: Error loading video:", error);
                }
            });
        }
        // Handle Audio
        else if (fileType.startsWith('audio/')) {
            const audioUrl = URL.createObjectURL(file);
            const audioEl = document.createElement('audio');
            audioEl.src = audioUrl;

            // Create visual representation
            const Rect = getConstructor('Rect');
            const Text = getConstructor('Text');
            const Group = getConstructor('Group');

            if (!Rect || !Text || !Group) return;

            const width = 300;
            const height = 80;

            const audioRect = new Rect({
                width: width,
                height: height,
                fill: '#1e293b',
                stroke: '#64748b',
                strokeWidth: 2,
                rx: 10,
                ry: 10
            });

            const audioIcon = new Text('🎵', {
                fontSize: 40,
                left: 20,
                top: 20,
                fill: '#ffffff'
            });

            const fileName = new Text(file.name.substring(0, 28), {
                fontSize: 14,
                left: 80,
                top: 15,
                fill: '#ffffff'
            });

            const audioLabel = new Text('Click para reproducir/pausar', {
                fontSize: 12,
                left: 80,
                top: 45,
                fill: '#94a3b8'
            });

            const audioGroup = new Group(
                [audioRect, audioIcon, fileName, audioLabel],
                {
                    left: (c.width || 400) / 2,
                    top: (c.height || 400) / 2,
                    originX: 'center',
                    originY: 'center',
                    selectable: true,
                    evented: true
                }
            );

            const groupId = Math.random().toString(36).substr(2, 9);
            (audioGroup as any).id = groupId;
            (audioGroup as any).audioElement = audioEl;
            (audioGroup as any).isAudio = true;

            // Simplified control - click anywhere on card to toggle Play/Pause
            audioGroup.on('mousedown', () => {
                if (audioEl.paused) {
                    audioEl.play();
                    console.log('DEBUG: Playing audio');
                } else {
                    audioEl.pause();
                    console.log('DEBUG: Pausing audio');
                }
            });

            c.add(audioGroup);
            c.setActiveObject(audioGroup);
            c.renderAll();

            socketRef.current?.emit('canvas-event', {
                room: roomId,
                type: 'object:added',
                id: groupId,
                data: audioGroup.toJSON(['id', 'globalCompositeOperation', 'objectCaching'])
            });

            saveHistory();
            console.log("DEBUG: Audio uploaded successfully");
        }
        // Handle Images
        else if (fileType.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const imgData = e.target?.result as string;

                    const ImageConstructor = getConstructor('Image');
                    if (!ImageConstructor) return;

                    const img = await ImageConstructor.fromURL(imgData, {
                        crossOrigin: 'anonymous'
                    });

                    const maxWidth = 800;
                    const maxHeight = 600;

                    if (img.width > maxWidth || img.height > maxHeight) {
                        const scale = Math.min(maxWidth / img.width, maxHeight / img.height);
                        img.scale(scale);
                    }

                    const center = { left: (c.width || 400) / 2, top: (c.height || 400) / 2 };
                    img.set({
                        left: center.left,
                        top: center.top,
                        originX: 'center',
                        originY: 'center',
                        id: Math.random().toString(36).substr(2, 9),
                        selectable: true,
                        evented: true
                    });

                    c.add(img);
                    c.setActiveObject(img);
                    c.renderAll();

                    socketRef.current?.emit('canvas-event', {
                        room: roomId,
                        type: 'object:added',
                        id: img.id,
                        data: img.toJSON(['id', 'globalCompositeOperation', 'objectCaching'])
                    });

                    saveHistory();
                    console.log("DEBUG: Image uploaded successfully");
                } catch (error) {
                    console.error("DEBUG: Error loading image:", error);
                }
            };

            reader.readAsDataURL(file);
        } else {
            console.warn('DEBUG: Unsupported file type:', fileType);
        }
    }, [isReadOnly, getConstructor, saveHistory, roomId]);

    const clearCanvas = useCallback(() => {
        const c = canvasRef.current;
        if (!c || isReadOnly) return;
        c.clear();
        socketRef.current?.emit('canvas-event', { room: roomId, type: 'clear' });
        saveHistory();
    }, [isReadOnly, saveHistory, roomId]);

    const testDraw = useCallback(() => {
        const c = canvasRef.current;
        if (!c) return;
        const Line = getConstructor('Line');
        if (Line) {
            const line = new Line([50, 50, 200, 200], { stroke: 'red', strokeWidth: 5 });
            c.add(line);
            c.renderAll();
        }
    }, [getConstructor]);

    return {
        setCanvasRef,
        addShape,
        addText,
        testDraw,
        clearCanvas,
        deleteSelected,
        undo,
        redo,
        copy,
        paste,
        cut,
        duplicate,
        resetWhiteboard,
        uploadImage,
        canvas,
        zoom,
        resetZoom,
        zoomIn,
        zoomOut,
        isConnected
    };
};
