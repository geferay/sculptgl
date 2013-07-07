'use strict';

function Sculpt(states)
{
  this.states_ = states; //for undo-redo
  this.mesh_ = null; //mesh
  this.intensity_ = 0.75; //deformation intensity
  this.tool_ = Sculpt.tool.BRUSH; //sculpting mode
  this.topo_ = Sculpt.topo.SUBDIVISION; //topological mode
  this.detail_ = 0.75; //intensity of details
  this.negative_ = false; //opposition deformation

  this.d2Min_ = 0; //uniform refinement of mesh (min edge length)
  this.d2Max_ = 0; //uniform refinement of mesh (max edge length)
  this.d2Thickness_ = 0.5; //distance between 2 vertices before split/merge
  this.d2Move_ = 0; //max displacement of vertices per step

  this.rotateData_ = {
    normal: [0, 0, 0], //normal of rotation plane
    center2d: [0, 0] //2D center of rotation 
  };
}

//the sculpting tools
Sculpt.tool = {
  BRUSH: 0,
  INFLATE: 1,
  ROTATE: 2,
  SMOOTH: 3,
  FLATTEN: 4
};

//the topological tools
Sculpt.topo = {
  STATIC: 0,
  SUBDIVISION: 1,
  DECIMATION: 2,
  UNIFORMISATION: 3,
  ADAPTIVE: 4
};

Sculpt.prototype = {
  /** Set adaptive parameters */
  setAdaptiveParameters: function (radiusSquared)
  {
    this.d2Max_ = radiusSquared * (1.1 - this.detail_) * 0.2;
    this.d2Min_ = this.d2Max_ / 4.2025;
    this.d2Move_ = this.d2Min_ * 0.2375;
    this.d2Thickness_ = (4.0 * this.d2Move_ + this.d2Max_ / 3.0) * 1.1;
  },

  /** Sculpt the mesh */
  sculptMesh: function (picking, mouseX, mouseY, lastMouseX, lastMouseY)
  {
    var mesh = this.mesh_;
    var iVertsSelected = picking.pickedVertices_;
    var radiusSquared = picking.rWorldSqr_;
    var center = picking.interPoint_;
    var vertices = mesh.vertices_;
    var iTris = mesh.getTrianglesFromVertices(iVertsSelected);

    //undo-redo
    this.states_.pushState(iTris, iVertsSelected);

    var topo = new Topology(this.states_);
    topo.mesh_ = mesh;
    topo.radiusSquared_ = radiusSquared;
    topo.center_ = center;
    this.setAdaptiveParameters(radiusSquared);
    switch (this.topo_)
    {
    case Sculpt.topo.SUBDIVISION:
      iTris = topo.subdivision(iTris, this.d2Max_);
      break;
    case Sculpt.topo.DECIMATION:
      iTris = topo.decimation(iTris, this.d2Min_);
      break;
    case Sculpt.topo.UNIFORMISATION:
    case Sculpt.topo.ADAPTIVE:
      iTris = topo.subdivision(iTris, this.d2Max_);
      iTris = topo.decimation(iTris, this.d2Min_);
      break;
    }

    iVertsSelected = mesh.getVerticesFromTriangles(iTris);
    var nbVertsSelected = iVertsSelected.length;
    var iVertsSculpt = [];
    var vertexSculptMask = Vertex.sculptMask_;
    for (var i = 0; i < nbVertsSelected; ++i)
    {
      if (vertices[iVertsSelected[i]].sculptFlag_ === vertexSculptMask)
        iVertsSculpt.push(iVertsSelected[i]);
    }
    switch (this.tool_)
    {
    case Sculpt.tool.BRUSH:
      this.flatten(center, iVertsSculpt, radiusSquared, this.intensity_ * 0.5);
      this.brush(center, iVertsSculpt, radiusSquared, this.intensity_);
      break;
    case Sculpt.tool.INFLATE:
      this.inflate(center, iVertsSculpt, radiusSquared, this.intensity_);
      break;
    case Sculpt.tool.ROTATE:
      this.rotate(center, iVertsSculpt, radiusSquared, mouseX, mouseY, lastMouseX, lastMouseY);
      break;
    case Sculpt.tool.SMOOTH:
      this.smooth(iVertsSculpt, this.intensity_);
      break;
    case Sculpt.tool.FLATTEN:
      this.flatten(center, iVertsSculpt, radiusSquared, this.intensity_);
      break;
    }

    if (this.topo_ === Sculpt.topo.ADAPTIVE)
    {
      iTris = topo.adaptTopology(iTris, this.d2Thickness_);
      iVertsSelected = mesh.getVerticesFromTriangles(iTris);
    }
    mesh.updateMesh(iTris, iVertsSelected);
  },

  /** Brush stroke, move vertices along a direction computed by their averaging normals */
  brush: function (center, iVerts, radiusSquared, intensity)
  {
    var aNormal = this.areaNormal(iVerts);
    var vAr = this.mesh_.vertexArray_;
    var radius = Math.sqrt(radiusSquared);
    var nbVerts = iVerts.length;
    var deformIntensity = intensity * radius * 0.1;
    if (this.topo_ === Sculpt.topo.ADAPTIVE)
      deformIntensity = Math.min(Math.sqrt(this.d2Move_), deformIntensity);
    if (this.negative_)
      deformIntensity = -deformIntensity;
    var cx = center[0],
      cy = center[1],
      cz = center[2];
    var anx = aNormal[0],
      any = aNormal[1],
      anz = aNormal[2];
    for (var i = 0; i < nbVerts; ++i)
    {
      var ind = iVerts[i] * 3;
      var dx = vAr[ind] - cx,
        dy = vAr[ind + 1] - cy,
        dz = vAr[ind + 2] - cz;
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz) / radius;
      var fallOff = 3 * dist * dist * dist * dist - 4 * dist * dist * dist + 1;
      vAr[ind] += anx * deformIntensity * fallOff;
      vAr[ind + 1] += any * deformIntensity * fallOff;
      vAr[ind + 2] += anz * deformIntensity * fallOff;
    }
  },

  /** Inflate a group of vertices */
  inflate: function (center, iVerts, radiusSquared, intensity)
  {
    var mesh = this.mesh_;
    var vAr = mesh.vertexArray_;
    var nAr = mesh.normalArray_;
    var nbVerts = iVerts.length;
    var radius = Math.sqrt(radiusSquared);
    var deformIntensity = intensity * radius * 0.1;
    if (this.topo_ === Sculpt.topo.ADAPTIVE)
      deformIntensity = Math.min(Math.sqrt(this.d2Move_), deformIntensity);
    if (this.negative_)
      deformIntensity = -deformIntensity;
    var cx = center[0],
      cy = center[1],
      cz = center[2];
    for (var i = 0; i < nbVerts; ++i)
    {
      var ind = iVerts[i] * 3;
      var dx = vAr[ind] - cx,
        dy = vAr[ind + 1] - cy,
        dz = vAr[ind + 2] - cz;
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz) / radius;
      var fallOff = 3 * dist * dist * dist * dist - 4 * dist * dist * dist + 1;
      vAr[ind] += nAr[ind] * deformIntensity * fallOff;
      vAr[ind + 1] += nAr[ind + 1] * deformIntensity * fallOff;
      vAr[ind + 2] += nAr[ind + 2] * deformIntensity * fallOff;
    }
  },

  /** Start a rotate sculpt session */
  startRotate: function (picking, mouseX, mouseY)
  {
    var rotateData = this.rotateData_;
    var mesh = this.mesh_;
    var vNear = Geometry.point2Dto3D(picking.camera_, mouseX, mouseY, 0),
      vFar = Geometry.point2Dto3D(picking.camera_, mouseX, mouseY, 1);
    var matInverse = mat4.create();
    mat4.invert(matInverse, mesh.matTransform_);
    vec3.transformMat4(vNear, vNear, matInverse);
    vec3.transformMat4(vFar, vFar, matInverse);
    picking.intersectionRayMesh(mesh, vNear, vFar, mouseX, mouseY);
    if (!picking.mesh_)
      return;
    picking.pickVerticesInSphere(picking.rWorldSqr_);
    var ray = [0, 0, 0];
    vec3.sub(ray, vNear, vFar);
    vec3.normalize(ray, ray);
    rotateData.normal = ray;
    rotateData.center2d = [mouseX, mouseY];
  },

  /** Rotate the vertices around the mouse point intersection */
  rotate: function (center, iVerts, radiusSquared, mouseX, mouseY, lastMouseX, lastMouseY)
  {
    var rotateData = this.rotateData_;
    var mouseCenter = rotateData.center2d;
    var vecMouse = [mouseX - mouseCenter[0], mouseY - mouseCenter[1]];
    if (vec2.len(vecMouse) < 30)
      return;
    vec2.normalize(vecMouse, vecMouse);
    var nPlane = rotateData.normal;
    var rot = [0, 0, 0, 0];
    var vecOldMouse = [lastMouseX - mouseCenter[0], lastMouseY - mouseCenter[1]];
    vec2.normalize(vecOldMouse, vecOldMouse);
    var angle = Geometry.signedAngle2d(vecMouse, vecOldMouse);
    var vAr = this.mesh_.vertexArray_;
    var radius = Math.sqrt(radiusSquared);
    var nbVerts = iVerts.length;
    var cx = center[0],
      cy = center[1],
      cz = center[2];
    for (var i = 0; i < nbVerts; ++i)
    {
      var ind = iVerts[i] * 3;
      var dx = vAr[ind] - cx,
        dy = vAr[ind + 1] - cy,
        dz = vAr[ind + 2] - cz;
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz) / radius;
      var fallOff = 3 * dist * dist * dist * dist - 4 * dist * dist * dist + 1;
      var coord = [vAr[ind], vAr[ind + 1], vAr[ind + 2]];
      quat.setAxisAngle(rot, nPlane, angle * fallOff);
      vec3.sub(coord, coord, center);
      vec3.transformQuat(coord, coord, rot);
      vec3.add(coord, coord, center);
      vAr[ind] = coord[0];
      vAr[ind + 1] = coord[1];
      vAr[ind + 2] = coord[2];
    }
  },

  /** Smooth a group of vertices. New position is given by simple averaging */
  smooth: function (iVerts, intensity)
  {
    var mesh = this.mesh_;
    var vAr = mesh.vertexArray_;
    var nbVerts = iVerts.length;
    var smoothVerts = new Float32Array(nbVerts * 3);
    this.laplacianSmooth(iVerts, smoothVerts);
    var d2Move = this.d2Move_;
    var dMove = Math.sqrt(d2Move);
    var limitMove = this.topo_ === Sculpt.topo.ADAPTIVE;
    for (var i = 0; i < nbVerts; ++i)
    {
      var ind = iVerts[i] * 3;
      var i3 = i * 3;
      var dx = (smoothVerts[i3] - vAr[ind]) * intensity,
        dy = (smoothVerts[i3 + 1] - vAr[ind + 1]) * intensity,
        dz = (smoothVerts[i3 + 2] - vAr[ind + 2]) * intensity;
      if (limitMove)
      {
        var len = dx * dx + dy * dy + dz * dz;
        if (len > d2Move)
        {
          len = Math.sqrt(len);
          dx = dx / len * dMove;
          dy = dy / len * dMove;
          dz = dz / len * dMove;
        }
      }
      vAr[ind] += dx;
      vAr[ind + 1] += dy;
      vAr[ind + 2] += dz;
    }
  },

  /** Flatten, projection of the sculpting vertex onto a plane defined by the barycenter and normals of all the sculpting vertices */
  flatten: function (center, iVerts, radiusSquared, intensity)
  {
    var aNormal = this.areaNormal(iVerts);
    var aCenter = this.areaCenter(iVerts);
    var vAr = this.mesh_.vertexArray_;
    var radius = Math.sqrt(radiusSquared);
    var nbVerts = iVerts.length;
    var deformIntensity = intensity * 0.3;
    var cx = center[0],
      cy = center[1],
      cz = center[2];
    var ax = aCenter[0],
      ay = aCenter[1],
      az = aCenter[2];
    var anx = aNormal[0],
      any = aNormal[1],
      anz = aNormal[2];
    var dMove = Math.sqrt(this.d2Move_);
    var limitMove = this.topo_ === Sculpt.topo.ADAPTIVE;
    for (var i = 0; i < nbVerts; ++i)
    {
      var ind = iVerts[i] * 3;
      var vx = vAr[ind],
        vy = vAr[ind + 1],
        vz = vAr[ind + 2];
      var distToPlane = (vx - ax) * anx + (vy - ay) * any + (vz - az) * anz;
      var dx = vx - cx,
        dy = vy - cy,
        dz = vz - cz;
      var distToCen = Math.sqrt(dx * dx + dy * dy + dz * dz) / radius;
      var fallOff = 3 * distToCen * distToCen * distToCen * distToCen - 4 * distToCen * distToCen * distToCen + 1;
      if (limitMove)
        fallOff = Math.min(dMove, distToPlane * deformIntensity * fallOff);
      else
        fallOff = distToPlane * deformIntensity * fallOff;
      vAr[ind] -= anx * fallOff;
      vAr[ind + 1] -= any * fallOff;
      vAr[ind + 2] -= anz * fallOff;
    }
  },

  /** Smooth a group of vertices along the plane defined by the normal of the vertex */
  smoothFlat: function (iVerts, intensity)
  {
    var mesh = this.mesh_;
    var vAr = mesh.vertexArray_;
    var nAr = mesh.normalArray_;
    var nbVerts = iVerts.length;
    var smoothVerts = new Float32Array(nbVerts * 3);
    this.laplacianSmooth(iVerts, smoothVerts);
    for (var i = 0; i < nbVerts; ++i)
    {
      var ind = iVerts[i] * 3;
      var vx = vAr[ind],
        vy = vAr[ind + 1],
        vz = vAr[ind + 2];
      var nx = nAr[ind],
        ny = nAr[ind + 1],
        nz = nAr[ind + 2];
      var i3 = i * 3;
      var smx = smoothVerts[i3],
        smy = smoothVerts[i3 + 1],
        smz = smoothVerts[i3 + 2];
      var dot = nx * (smx - vx) + ny * (smy - vy) + nz * (smz - vz);
      vAr[ind] += (smx - nx * dot - vx) * intensity;
      vAr[ind + 1] += (smy - ny * dot - vy) * intensity;
      vAr[ind + 2] += (smz - nz * dot - vz) * intensity;
    }
  },

  /** Laplacian smooth. Special rule for vertex on the edge of the mesh. */
  laplacianSmooth: function (iVerts, smoothVerts)
  {
    var mesh = this.mesh_;
    var vertices = mesh.vertices_;
    var vAr = mesh.vertexArray_;
    var nbVerts = iVerts.length;
    for (var i = 0; i < nbVerts; ++i)
    {
      var i3 = i * 3;
      var vert = vertices[iVerts[i]];
      var ivRing = vert.ringVertices_;
      var nbVRing = ivRing.length;
      var nx = 0,
        ny = 0,
        nz = 0;
      var j = 0,
        ind = 0;
      if (nbVRing !== vert.tIndices_.length) //edge vertex (or singular stuff...)
      {
        var nbVertEdge = 0;
        for (j = 0; j < nbVRing; ++j)
        {
          ind = ivRing[j];
          var ivr = vertices[ind];
          //we average only with vertices that are also on the edge
          if (ivr.ringVertices_.length !== ivr.tIndices_.length)
          {
            ind *= 3;
            nx += vAr[ind];
            ny += vAr[ind + 1];
            nz += vAr[ind + 2];
            ++nbVertEdge;
          }
        }
        smoothVerts[i3] = nx / nbVertEdge;
        smoothVerts[i3 + 1] = ny / nbVertEdge;
        smoothVerts[i3 + 2] = nz / nbVertEdge;
      }
      else
      {
        for (j = 0; j < nbVRing; ++j)
        {
          ind = ivRing[j] * 3;
          nx += vAr[ind];
          ny += vAr[ind + 1];
          nz += vAr[ind + 2];
        }
        smoothVerts[i3] = nx / nbVRing;
        smoothVerts[i3 + 1] = ny / nbVRing;
        smoothVerts[i3 + 2] = nz / nbVRing;
      }
    }
  },

  /** Compute average normal of a group of vertices with culling */
  areaNormal: function (iVerts)
  {
    var nAr = this.mesh_.normalArray_;
    var nbVerts = iVerts.length;
    var anx = 0,
      any = 0,
      anz = 0;
    for (var i = 0; i < nbVerts; ++i)
    {
      var ind = iVerts[i] * 3;
      anx += nAr[ind];
      any += nAr[ind + 1];
      anz += nAr[ind + 2];
    }
    var len = 1 / Math.sqrt(anx * anx + any * any + anz * anz);
    return [anx * len, any * len, anz * len];
  },

  /** Compute average center of a group of vertices (with culling) */
  areaCenter: function (iVerts)
  {
    var vAr = this.mesh_.vertexArray_;
    var nbVerts = iVerts.length;
    var ax = 0,
      ay = 0,
      az = 0;
    for (var i = 0; i < nbVerts; ++i)
    {
      var ind = iVerts[i] * 3;
      ax += vAr[ind];
      ay += vAr[ind + 1];
      az += vAr[ind + 2];
    }
    return [ax / nbVerts, ay / nbVerts, az / nbVerts];
  }
};