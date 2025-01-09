# Character Publisher Federation Integration Requirements

## Required Endpoints

### 1. `/federation-info` (GET)
Primary endpoint for federation capability discovery and character information.

```json
{
  "version": "1.0.0",
  "features": ["character-federation", "signature-verification"],
  "modelProviders": ["openai", "anthropic", "local"],
  "characterInfo": {
    "assets": {
      "domain": "https://assets.example.com",
      "profileImages": "characters/author/slug/profile.jpg",
      "bannerImages": "characters/author/slug/banner.jpg",
      "vrmModels": "characters/author/slug/model.vrm"
    }
  }
}
```

### 2. `/verify-ownership` (POST)
Handles challenge-response authentication for source verification.

**Request:**
```json
{
  "username": "character-author",
  "challenge": "uuid-challenge-string"
}
```

**Response:**
```json
{
  "signature": "base64-encoded-ed25519-signature"
}
```

### 3. `/get-author-characters` (POST)
Provides character information for a specific author.

**Request:**
```json
{
  "author": "character-author"
}
```

**Response:**
```json
{
  "username": "character-author",
  "member_since": "2024-01-01",
  "website": "https://example.com",
  "github": "github-username",
  "twitter": "twitter-handle",
  "characters": [
    {
      "id": "unique-character-id",
      "slug": "character-slug",
      "name": "Character Name",
      "version": "1.0.0",
      "bio": "Character description",
      "model_provider": "openai",
      "status": "public",
      "vrm_url": "https://assets.example.com/characters/author/slug/model.vrm",
      "profile_img": "https://assets.example.com/characters/author/slug/profile.jpg",
      "banner_img": "https://assets.example.com/characters/author/slug/banner.jpg",
      "settings": {
      },
      "signature": "base64-signature",
      "wallets": {
        "ETH": "0x..."
      }
    }
  ]
}
```

## Security Requirements

### 1. Ed25519 Key Pair Generation
- Generate an Ed25519 key pair for signing characters and challenges
- Store private key securely
- Make public key available for federation nodes

### 2. Character Signing
Each character must be signed with the publisher's Ed25519 private key:
1. Create a message containing character metadata:
```json
{
  "id": "unique-character-id",
  "name": "Character Name",
  "version": "1.0.0",
  "bio": "Character description"
}
```
2. Sign the UTF-8 encoded JSON with Ed25519
3. Include base64-encoded signature with character metadata

### 3. Challenge-Response Authentication
- Accept challenge strings from federation nodes
- Sign challenges with Ed25519 private key
- Return base64-encoded signatures

## Asset Storage Requirements

### 1. Asset Organization
- Maintain consistent folder structure for character assets
- Store profile images, banner images, and VRM models
- Use predictable naming patterns

### 2. Version Management
- Maintain all published character versions
- Never delete old versions
- Include version in character metadata

## Character Metadata Requirements

### 1. Required Fields
- `id`: Unique identifier
- `slug`: URL-friendly identifier
- `name`: Display name
- `version`: Semantic version
- `bio`: Character description
- `model_provider`: AI model provider
- `status`: Public/private visibility
- `signature`: Ed25519 signature

### 2. Optional Fields
- `vrm_url`: VRM model URL
- `profile_img`: Profile image URL
- `banner_img`: Banner image URL
- `wallets`: Associated crypto wallets
- `settings`: Character configuration

## Implementation Checklist

1. Server Setup:
   - [ ] Configure Ed25519 key pair
   - [ ] Set up secure key storage
   - [ ] Implement required endpoints

2. Character Management:
   - [ ] Add signature generation
   - [ ] Implement version tracking
   - [ ] Set up asset storage
   - [ ] Configure model providers

3. Federation Support:
   - [ ] Implement challenge-response
   - [ ] Add federation info endpoint
   - [ ] Set up character data endpoint

4. Security:
   - [ ] Secure private key storage
   - [ ] Implement signature verification
   - [ ] Add request validation
   - [ ] Configure wallet management

5. Character Privacy:
   - [ ] Implement visibility controls
   - [ ] Manage access permissions
   - [ ] Secure sensitive settings

## Example Implementation Notes

1. Initialize Ed25519 keys:
```javascript
const crypto = require('crypto');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
```

2. Sign a challenge:
```javascript
function signChallenge(challenge, privateKey) {
  const message = Buffer.from(challenge);
  const signature = crypto.sign(null, message, privateKey);
  return signature.toString('base64');
}
```

3. Sign character metadata:
```javascript
function signCharacterMetadata(character, privateKey) {
  const message = JSON.stringify({
    id: character.id,
    name: character.name,
    version: character.version,
    bio: character.bio
  });
  const signature = crypto.sign(null, Buffer.from(message), privateKey);
  return signature.toString('base64');
}
```

4. Federation info endpoint:
```javascript
app.get('/federation-info', (req, res) => {
  res.json({
    version: '1.0.0',
    features: ['character-federation', 'signature-verification'],
    modelProviders: ['openai', 'anthropic', 'local'],
    characterInfo: {
      assets: {
        domain: 'https://assets.example.com',
        profileImages: 'characters/author/slug/profile.jpg',
        bannerImages: 'characters/author/slug/banner.jpg',
        vrmModels: 'characters/author/slug/model.vrm'
      }
    }
  });
});
```

5. Model provider configuration:
```javascript
const modelProviders = {
  openai: {
    type: 'openai',
    requiresApiKey: true,
    models: ['gpt-3.5-turbo', 'gpt-4'],
    defaultModel: 'gpt-3.5-turbo'
  },
  anthropic: {
    type: 'anthropic',
    requiresApiKey: true,
    models: ['claude-2', 'claude-instant'],
    defaultModel: 'claude-instant'
  }
};
```

6. Character privacy management:
```javascript
function isCharacterAccessible(character, requestingUser) {
  if (character.status === 'public') return true;
  if (character.author === requestingUser) return true;
  return false;
}
```
