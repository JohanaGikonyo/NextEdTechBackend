import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeH5pComEmbed, parseScormManifest } from './package-content.service.js';

function embedPage(jsonContent: object) {
  const integration = {
    url: 'https://eu-west-1.cdn.h5p.com/orgs/42/organization',
    contents: { 'cid-777': { jsonContent: JSON.stringify(jsonContent), title: 'a "quoted" {title}' } },
  };
  return `<script>H5PIntegration = ${JSON.stringify(integration)};</script>`;
}

describe('describeH5pComEmbed', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds the CDN URL of a locally stored interactive video', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(embedPage({ interactiveVideo: { video: { files: [{ path: 'videos/abc.mp4' }] } } }))));

    await expect(describeH5pComEmbed('https://me.h5p.com/content/777/embed')).resolves.toEqual({
      video: 'https://eu-west-1.cdn.h5p.com/orgs/42/organization/content/777/videos/abc.mp4',
      image: null,
      captions: null,
    });
  });

  it('uses the YouTube thumbnail for YouTube-sourced videos', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(embedPage({ files: [{ path: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }] }))));

    await expect(describeH5pComEmbed('https://me.h5p.com/content/777/embed')).resolves.toEqual({
      video: null,
      image: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
      captions: null,
    });
  });

  it('refuses non-H5P.com hosts', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(describeH5pComEmbed('https://evil.example.com/x')).resolves.toEqual({ video: null, image: null, captions: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('parseScormManifest', () => {
  it('finds the launch page of a Captivate SCORM 1.2 package', () => {
    const xml = `<?xml version="1.0"?>
      <manifest identifier="Course_ID1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
        <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
        <organizations default="Course_ID1_ORG">
          <organization identifier="Course_ID1_ORG">
            <title>Demo</title>
            <item identifier="SCO_ID1" isvisible="true" identifierref="SCO_ID1_RES"><title>Demo</title></item>
          </organization>
        </organizations>
        <resources>
          <resource identifier="SHARED" type="webcontent" adlcp:scormtype="asset" href="shared/a.js"/>
          <resource adlcp:scormtype="sco" href="index_scorm.html" identifier="SCO_ID1_RES" type="webcontent"/>
        </resources>
      </manifest>`;

    expect(parseScormManifest(xml)).toEqual({ version: '1.2', launch: 'index_scorm.html' });
  });

  it('detects SCORM 2004 and applies xml:base', () => {
    const xml = `<manifest>
        <metadata><schemaversion>2004 4th Edition</schemaversion></metadata>
        <organizations default="ORG"><organization identifier="ORG">
          <item identifier="I1" identifierref="R1"/>
        </organization></organizations>
        <resources><resource identifier="R1" xml:base="content/" href="start.html"/></resources>
      </manifest>`;

    expect(parseScormManifest(xml)).toEqual({ version: '2004', launch: 'content/start.html' });
  });
});
