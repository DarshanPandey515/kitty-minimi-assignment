import { useMemo } from "react";


const PIXELS_32 = [
    "................................",
    "......##................##......",
    ".....####..............####.....",
    "....#PPPP#............#PPPP#....",
    "...#PPPPPP#..........#PPPPPP#...",
    "..#PPPPPPPP#........#PPPPPPPP#..",
    "..#PPPPPPPP#..####..#PPPPPPPP#..",
    "..#PPPPPPPP###FFFF###PPPPPPPP#..",
    "..#SHHHHHHHHHHHHHHHHHHHHHHHHS#..",
    ".#SHHHHHHHHHHHHHHHHHHHHHHHHHHS#.",
    ".#SFFFFFFFFFFFFFFFFFFFFFFFFFFS#.",
    ".#SFFFEEEEFFFFFFFFFFFFEEEEFFFS#.",
    ".#SFFFWEEEFFFFFFFFFFFFWEEEFFFS#.",
    ".#SFFFWEEEFFFFFFFFFFFFWEEEFFFS#.",
    ".#SFFFEEEEFFFFFFFFFFFFEEEEFFFS#.",
    ".#SFFFFEEFFFFFFFFFFFFFFEEFFFFS#.",
    ".#SFFFFFFFFFFFFFFFFFFFFFFFFFFS#.",
    ".#SFFBBBFFFFFFFNNFFFFFFFBBBFFS#.",
    ".#SFFBBBFFFFFFFNNFFFFFFFBBBFFS#.",
    ".#SFFFFFFFFFFFMFFMFFFFFFFFFFFS#.",
    ".#SFFFFFFFFFFFFMMFFFFFFFFFFFFS#.",
    ".#SFFFFFFFFFFFFFFFFFFFFFFFFFFS#.",
    ".#SSFFFFFFFFFFFFFFFFFFFFFFFFSS#.",
    "..#SSFFFFFFFFFFFFFFFFFFFFFFSS#..",
    "..#SSFFFFFFFFFFFFFFFFFFFFFFSS#..",
    "...#SSFFFFFFFFFFFFFFFFFFFFSS#...",
    "....#SSFFFFFFFFFFFFFFFFSS#....",
    ".....#SSFFFFFFFFFFFFFFFFSS#.....",
    "......#SSSSSSSSSSSSSSSSSS#......",
    ".......#SSSSSSSSSSSSSSSS#.......",
    "........################........",
    "................................",
];

const PIXEL_COLORS_32: Record<string, string> = {
    "#": "#241634", // outline
    S: "#c2740a",   // fur shadow
    F: "#fbbf24",   // fur base
    H: "#fde68a",   // fur highlight (rim light)
    P: "#fb7185",   // ear interior
    E: "#1a0f2e",   // eye
    W: "#ffffff",   // eye shine
    N: "#e11d48",   // nose
    M: "#7c2d12",   // mouth
    B: "#fda4af",   // blush
};

function PixelCat({
    pixels = PIXELS_32,
    colors = PIXEL_COLORS_32,
    className = "",
}: {
    pixels?: string[];
    colors?: Record<string, string>;
    className?: string;
}) {
    const w = pixels[0].length;
    const h = pixels.length;

    const paths = useMemo(() => {
        const byColor: Record<string, string[]> = {};
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const ch = pixels[y][x];
                if (!colors[ch]) continue;
                (byColor[ch] ??= []).push(`M${x} ${y}h1v1h-1z`);
            }
        }
        return Object.entries(byColor).map(([ch, d]) => ({
            fill: colors[ch],
            d: d.join(""),
        }));
    }, [pixels, colors, w, h]);

    return (
        <svg
            viewBox={`0 0 ${w} ${h}`}
            className={className}
            shapeRendering="crispEdges"
            aria-hidden
        >
            {paths.map((p) => (
                <path key={p.fill} d={p.d} fill={p.fill} />
            ))}
        </svg>
    );
}



export default PixelCat;