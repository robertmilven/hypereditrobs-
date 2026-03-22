import { useRef, useCallback, useState, useMemo } from 'react';
import { Film, Image, Music, Upload, Trash2, Plus, Sparkles, ImageIcon, ExternalLink, ChevronDown, ChevronRight, Video, Volume2, Palette, Search, X } from 'lucide-react';
import type { Asset } from '@/react-app/hooks/useProject';

interface AssetLibraryProps {
  assets: Asset[];
  onUpload: (files: FileList) => void;
  onDelete: (assetId: string) => void;
  onDragStart: (asset: Asset) => void;
  onSelect?: (assetId: string | null) => void;
  selectedAssetId?: string | null;
  uploading?: boolean;
  onOpenGifSearch?: () => void;
}

const getAssetIcon = (type: Asset['type']) => {
  switch (type) {
    case 'video': return Film;
    case 'image': return Image;
    case 'audio': return Music;
    default: return Film;
  }
};

const getAssetColor = (type: Asset['type']) => {
  switch (type) {
    case 'video': return 'from-blue-500 to-cyan-500';
    case 'image': return 'from-amber-500 to-orange-500';
    case 'audio': return 'from-emerald-500 to-teal-500';
    default: return 'from-gray-500 to-gray-600';
  }
};

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const FREE_RESOURCES = [
  { name: 'Pexels', url: 'https://www.pexels.com/', icon: Video, color: 'from-green-500 to-emerald-500', desc: 'Free videos & photos' },
  { name: 'Pixabay', url: 'https://pixabay.com/', icon: Image, color: 'from-green-600 to-teal-500', desc: 'Videos, images, music' },
  { name: 'Unsplash', url: 'https://unsplash.com/', icon: Image, color: 'from-gray-600 to-gray-500', desc: 'High-quality photos' },
  { name: 'GIPHY', url: 'https://giphy.com/', icon: Sparkles, color: 'from-violet-500 to-purple-500', desc: 'GIFs & stickers' },
  { name: 'Mixkit', url: 'https://mixkit.co/', icon: Video, color: 'from-purple-500 to-indigo-500', desc: 'Video clips & music' },
  { name: 'Freesound', url: 'https://freesound.org/', icon: Volume2, color: 'from-orange-500 to-red-500', desc: 'Sound effects & audio' },
  { name: 'LottieFiles', url: 'https://lottiefiles.com/', icon: Palette, color: 'from-cyan-500 to-blue-500', desc: 'Free animations' },
  { name: 'Remotion FX', url: 'https://remotion-prompt-builder-dvvbtm238-pprholdings123-6893s-projects.vercel.app/effects', icon: Sparkles, color: 'from-pink-500 to-rose-500', desc: 'Remotion effects builder' },
];

export default function AssetLibrary({
  assets,
  onUpload,
  onDelete,
  onDragStart,
  onSelect,
  selectedAssetId,
  uploading = false,
  onOpenGifSearch,
}: AssetLibraryProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'video' | 'image' | 'audio'>('all');

  // Filter and sort assets
  const filteredAssets = useMemo(() => {
    return assets.filter(asset => {
      // Type filter
      if (typeFilter !== 'all' && asset.type !== typeFilter) return false;
      // Search filter
      if (searchQuery && !asset.filename.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });
  }, [assets, searchQuery, typeFilter]);

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      onUpload(files);
      // Reset input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [onUpload]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      onUpload(files);
    }
  }, [onUpload]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return (
    <div className="flex flex-col h-full bg-zinc-900/50 border-r border-zinc-800/50">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/50">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-400">Assets</span>
          <a
            href="https://papaya-cucurucho-c76b49.netlify.app/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-1 px-2.5 py-1 min-w-[70px] bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 rounded text-[10px] font-medium text-white transition-all"
          >
            My Site <ExternalLink className="w-2.5 h-2.5" />
          </a>
          <a
            href="https://aiingection.netlify.app/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-1 px-2.5 py-1 min-w-[70px] bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 rounded text-[10px] font-medium text-white transition-all"
          >
            Prompts <ExternalLink className="w-2.5 h-2.5" />
          </a>
        </div>
        <div className="flex items-center gap-1.5">
          {onOpenGifSearch && (
            <button
              onClick={onOpenGifSearch}
              className="p-1.5 bg-purple-600 hover:bg-purple-500 rounded text-xs transition-colors"
              title="Search GIFs & Memes"
            >
              <ImageIcon className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={handleFileSelect}
            disabled={uploading}
            className="p-1.5 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed rounded text-xs transition-colors"
            title="Import files"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Search & Filter Bar */}
      {assets.length > 0 && (
        <div className="px-2 py-2 border-b border-zinc-800/50 space-y-2">
          {/* Search Input */}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search assets..."
              className="w-full pl-7 pr-7 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-orange-500/50"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Type Filter Pills */}
          <div className="flex gap-1">
            {(['all', 'video', 'image', 'audio'] as const).map((type) => (
              <button
                key={type}
                onClick={() => setTypeFilter(type)}
                className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                  typeFilter === type
                    ? 'bg-orange-500 text-white'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                }`}
              >
                {type === 'all' ? 'All' : type.charAt(0).toUpperCase() + type.slice(1)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="video/*,image/*,audio/*"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* Asset grid */}
      <div
        className="flex-1 overflow-auto p-2"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {assets.length === 0 ? (
          <div
            onClick={handleFileSelect}
            className="flex flex-col items-center justify-center h-full p-4 border-2 border-dashed border-zinc-700 rounded-lg cursor-pointer hover:border-orange-500/50 hover:bg-orange-500/5 transition-colors"
          >
            <Upload className="w-8 h-8 text-zinc-500 mb-2" />
            <span className="text-xs text-zinc-500 text-center">
              Drop files here or click to upload
            </span>
          </div>
        ) : filteredAssets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-4">
            <Search className="w-8 h-8 text-zinc-600 mb-2" />
            <span className="text-xs text-zinc-500 text-center">
              No assets match your search
            </span>
            <button
              onClick={() => { setSearchQuery(''); setTypeFilter('all'); }}
              className="mt-2 text-xs text-orange-400 hover:text-orange-300"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {filteredAssets.map(asset => (
              <AssetCard
                key={asset.id}
                asset={asset}
                isSelected={selectedAssetId === asset.id}
                onSelect={() => onSelect?.(selectedAssetId === asset.id ? null : asset.id)}
                onDelete={() => onDelete(asset.id)}
                onDragStart={() => onDragStart(asset)}
              />
            ))}

            {/* Add more button */}
            <button
              onClick={handleFileSelect}
              disabled={uploading}
              className="aspect-video flex flex-col items-center justify-center border-2 border-dashed border-zinc-700 rounded-lg cursor-pointer hover:border-orange-500/50 hover:bg-orange-500/5 transition-colors"
            >
              <Plus className="w-6 h-6 text-zinc-500" />
              <span className="text-[10px] text-zinc-500 mt-1">Add</span>
            </button>
          </div>
        )}

        {uploading && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <div className="animate-spin w-6 h-6 border-2 border-purple-500 border-t-transparent rounded-full" />
          </div>
        )}
      </div>

      {/* Free Resources Section */}
      <div className="border-t border-zinc-800/50">
        <button
          onClick={() => setResourcesOpen(!resourcesOpen)}
          className="flex items-center justify-between w-full px-3 py-2 hover:bg-zinc-800/30 transition-colors"
        >
          <span className="text-xs font-medium text-zinc-400">Free Resources</span>
          {resourcesOpen ? (
            <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />
          )}
        </button>

        {resourcesOpen && (
          <div className="px-2 pb-2 grid grid-cols-2 gap-1.5">
            {FREE_RESOURCES.map((resource) => {
              const Icon = resource.icon;
              return (
                <a
                  key={resource.name}
                  href={resource.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.open(resource.url, '_blank', 'noopener,noreferrer');
                  }}
                  className={`flex items-center gap-2 px-2 py-1.5 bg-gradient-to-r ${resource.color} rounded text-[10px] font-medium text-white hover:opacity-90 transition-opacity cursor-pointer`}
                  title={resource.desc}
                >
                  <Icon className="w-3 h-3" />
                  <span className="flex-1">{resource.name}</span>
                  <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                </a>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface AssetCardProps {
  asset: Asset;
  isSelected?: boolean;
  onSelect?: () => void;
  onDelete: () => void;
  onDragStart: () => void;
}

function AssetCard({ asset, isSelected, onSelect, onDelete, onDragStart }: AssetCardProps) {
  const Icon = getAssetIcon(asset.type);
  const colorClass = getAssetColor(asset.type);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('application/x-hyperedit-asset', JSON.stringify(asset));
    e.dataTransfer.effectAllowed = 'copy';
    onDragStart();
  }, [asset, onDragStart]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    // Don't select if clicking on buttons
    if ((e.target as HTMLElement).closest('button')) return;
    onSelect?.();
  }, [onSelect]);

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onClick={handleClick}
      className={`group relative aspect-video bg-zinc-800 rounded-lg overflow-hidden cursor-grab active:cursor-grabbing border transition-colors ${
        isSelected
          ? 'border-orange-500 ring-2 ring-orange-500/30'
          : 'border-zinc-700/50 hover:border-orange-500/50'
      }`}
    >
      {/* Thumbnail */}
      {asset.thumbnailUrl ? (
        <img
          src={asset.thumbnailUrl}
          alt={asset.filename}
          className="w-full h-full object-cover"
          draggable={false}
        />
      ) : (
        <div className={`w-full h-full bg-gradient-to-br ${colorClass} flex items-center justify-center`}>
          <Icon className="w-8 h-8 text-white/80" />
        </div>
      )}

      {/* Type badge */}
      <div className={`absolute top-1 left-1 px-1.5 py-0.5 rounded bg-gradient-to-r ${colorClass} text-[9px] font-medium uppercase`}>
        {asset.type}
      </div>

      {/* AI-generated badge */}
      {asset.aiGenerated && (
        <div
          className="absolute top-1 left-[52px] px-1.5 py-0.5 rounded bg-gradient-to-r from-purple-500 to-pink-500 text-[9px] font-medium flex items-center gap-0.5"
          title="AI-generated Remotion animation"
        >
          <Sparkles className="w-2.5 h-2.5" />
          AI
        </div>
      )}

      {/* Duration/info */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-2 py-1">
        <div className="text-[10px] text-white truncate">{asset.filename}</div>
        <div className="text-[9px] text-zinc-400">
          {asset.type !== 'image' && formatDuration(asset.duration)}
          {asset.type !== 'image' && ' • '}
          {formatSize(asset.size)}
        </div>
      </div>

      {/* Action buttons */}
      <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {/* Delete button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="p-1 bg-red-500/80 hover:bg-red-500 rounded"
          title="Delete asset"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
